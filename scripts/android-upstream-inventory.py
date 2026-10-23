#!/usr/bin/env python3
"""Generate developer inventory from upstream identities, never runtime eligibility.

Run with uv (or the project venv). Local Git objects are read by default. An
explicit --fetch-metadata downloads missing build-definition blobs only. No
upstream builds or application code execute.
"""
import argparse
import collections
import concurrent.futures
import functools
import hashlib
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
ENV = dict(os.environ, GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")


@functools.lru_cache(maxsize=None)
def blueprint_parser_identity(executable):
    path = Path(executable).resolve()
    return {"implementation": "original-blueprint", "executable": str(path),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def parse_blueprints(documents):
    if not documents:
        return []
    executable = os.environ.get("ANDROID_BLUEPRINT_PARSER")
    if not executable:
        raise RuntimeError("Set ANDROID_BLUEPRINT_PARSER to the original Blueprint parser, or acquire the pinned release to build it automatically")
    return json.loads(subprocess.check_output([executable], input=json.dumps(documents).encode(), timeout=120))


def refresh_blueprint_parser(output, go="go"):
    """Let Go's cache rebuild the transport over the existing pinned package."""
    output = output.resolve()
    identity_file = output / "parser-sources.json"
    identity = json.loads(identity_file.read_text())
    executable = output / "bin/android-blueprint-parser"
    executable.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, GOPATH=str(output), GOCACHE=str(output / "cache"), GO111MODULE="off", GOWORK="off")
    driver = ROOT / "scripts/android-blueprint/main.go"
    subprocess.run([go, "build", "-o", str(executable), str(driver)], env=env, check=True)
    identity["driverSha256"] = hashlib.sha256(driver.read_bytes()).hexdigest()
    identity_file.write_text(json.dumps(identity, indent=2) + "\n")
    blueprint_parser_identity.cache_clear()
    return str(executable)


def bootstrap_blueprint_parser(manifest, cache, output, go="go"):
    """Bootstrap the original Go package before parsing any build declaration.

    The driver imports the original parser package, whose own Go source files
    and standard-library imports are selected by Go. No Blueprint grammar is
    needed to compile the parser itself.
    """
    project = next(project for project in manifest["projects"] if project["name"] == "platform/build/blueprint")
    directory, repository, revision = acquire_release_checkout(project, cache, "https://android.googlesource.com")
    output = output.resolve()
    destination = output / "src/github.com/google/blueprint"
    listing = git(directory, "ls-tree", "-r", "-z", revision, "--", "parser", "LICENSE", "NOTICE")
    entries = []
    for raw in listing.split(b"\0"):
        if not raw:
            continue
        metadata, filename = raw.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        if kind == "blob":
            entries.append((filename.decode(), mode, oid))
    hashes = list(dict.fromkeys(oid for _, _, oid in entries))
    present = subprocess.check_output(["git", "-C", str(directory), "cat-file", "--batch-check"], env=ENV,
        input=("\n".join(hashes) + "\n").encode(), timeout=30).decode().splitlines()
    fetch_metadata_objects(directory, [line.split()[0] for line in present if line.endswith(" missing")])
    files = []
    for filename, mode, oid in entries:
        data = git(directory, "cat-file", "blob", oid)
        target = destination / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        if mode == "120000":
            if target.is_symlink():
                target.unlink()
            target.symlink_to(data.decode())
        else:
            target.write_bytes(data)
            target.chmod(0o755 if mode == "100755" else 0o644)
        files.append({"path": filename, "gitObject": oid, "sha256": hashlib.sha256(data).hexdigest()})
    (output / "parser-sources.json").write_text(json.dumps({"project": project["name"], "repository": repository,
        "revision": revision, "files": files}, indent=2) + "\n")
    return refresh_blueprint_parser(output, go)


def git(directory, *args):
    return subprocess.check_output(
        ["git", "-C", str(directory), *args], env=ENV, stderr=subprocess.PIPE,
        timeout=30)


def canonical(url):
    return url.rstrip("/").removesuffix(".git")


def manifest_projects(checkout, revision, filename="default.xml"):
    """Includes and nested projects come from the pinned manifest, not a list."""
    projects, files, gaps, nodes = [], [], [], []

    def read(name, ancestry=()):
        if name in ancestry or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            raise ValueError("Invalid manifest include: " + name)
        data = git(checkout, "show", f"{revision}:{name}")
        files.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
        document = ET.fromstring(data)
        if document.tag != "manifest":
            raise ValueError("Expected manifest root in " + name)
        for node in document:
            if node.tag == "include":
                read(node.attrib["name"], (*ancestry, name))
            else:
                nodes.append((name, node))

    read(filename)
    defaults = {}
    remotes = {}
    for _, node in nodes:
        if node.tag == "default":
            defaults.update(node.attrib)
        elif node.tag == "remote":
            remotes[node.attrib["name"]] = dict(node.attrib)

    def project(node, file, parent=None):
        attributes = dict(node.attrib)
        name = attributes["name"]
        location = attributes.get("path", name)
        if parent:
            name = parent["name"] + "/" + name
            location = parent["path"] + "/" + location
        remote = remotes.get(attributes.get("remote", defaults.get("remote")), {})
        row = {"name": name, "path": location, "manifest": file,
               "revision": attributes.get("revision", remote.get("revision", defaults.get("revision"))),
               "remote": remote, "attributes": attributes}
        projects.append(row)
        for child in node:
            if child.tag == "project":
                project(child, file, row)
            elif child.tag in ("copyfile", "linkfile"):
                row.setdefault("fileMappings", []).append({"kind": child.tag, **child.attrib})
            elif child.tag not in ("copyfile", "linkfile", "annotation"):
                gaps.append({"file": file, "kind": child.tag, "project": name,
                             "reason": "Unresolved manifest project directive"})

    for file, node in nodes:
        if node.tag == "project":
            project(node, file)
        elif node.tag == "remove-project":
            projects[:] = [p for p in projects if not (
                p["name"] == node.get("name") and
                (not node.get("path") or p["path"] == node.get("path")))]
        elif node.tag == "extend-project":
            matching = [p for p in projects if p["name"] == node.get("name") and
                        (not node.get("path") or p["path"] == node.get("path"))]
            for row in matching:
                row["attributes"].update(node.attrib)
                if node.get("revision"):
                    row["revision"] = node.get("revision")
                if node.get("dest-path"):
                    row["path"] = node.get("dest-path")
                if node.get("remote"):
                    row["remote"] = remotes.get(node.get("remote"), {})
            if not matching:
                gaps.append({"file": file, "kind": node.tag, "attributes": node.attrib,
                             "reason": "No matching project for extension"})
        elif node.tag not in ("default", "remote", "notice", "manifest-server", "repo-hooks", "superproject", "contactinfo"):
            gaps.append({"file": file, "kind": node.tag, "attributes": node.attrib,
                         "reason": "Manifest directive requires resolution; project coverage is incomplete"})
    return {"revision": revision, "files": files, "defaults": defaults, "projects": projects, "gaps": gaps}


def checkouts(roots):
    result = collections.defaultdict(list)
    for root in roots:
        for directory, names, _ in os.walk(root):
            names[:] = [n for n in names if n not in ("node_modules", "build", "out", ".cache")]
            marker = Path(directory) / ".git"
            if marker.exists():
                try:
                    url = git(directory, "remote", "get-url", "origin").decode().strip()
                    result[canonical(url)].append(Path(directory))
                except (subprocess.SubprocessError, OSError):
                    pass
                # A supplied root can itself be a checkout containing submodules.
                # Declared submodules are supplied separately from the pin file.
                names[:] = []
    return result


def build_definition(name):
    leaf = PurePosixPath(name).name
    return (name.endswith(".bp") or leaf in (".gitmodules", "Android.mk", "Makefile", "makefile", "GNUmakefile", "CMakeLists.txt", "BUILD", "BUILD.bazel", "BUILD.gn", "meson.build", "pom.xml", "Cargo.toml")
            or name.endswith((".mk", ".gni", ".cmake", ".gradle", ".gradle.kts", ".bzl")))


def submodule_declarations(directory, revision, filename=".gitmodules"):
    configuration = git(directory, "config", "--null", "--list", "--blob", revision + ":" + filename)
    sections = collections.defaultdict(dict)
    for item in configuration.decode().split("\0"):
        if not item or "\n" not in item:
            continue
        key, value = item.split("\n", 1)
        if not key.startswith("submodule.") or "." not in key[10:]:
            continue
        section, property_name = key[10:].rsplit(".", 1)
        sections[section][property_name] = value
    return dict(sections)


def fetch_metadata_objects(directory, hashes):
    # Use Git's own promisor-object fetch protocol: these are blob identities,
    # not revisions to traverse, and unrelated implementation blobs stay absent.
    for offset in range(0, len(hashes), 256):
        subprocess.run(["git", "-C", str(directory), "-c", "fetch.negotiationAlgorithm=noop",
                        "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance",
                        "--recurse-submodules=no", "--filter=blob:none", "origin", "--stdin"],
                       input=("\n".join(hashes[offset:offset + 256]) + "\n").encode(),
                       env=ENV, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)


def inspect_repository(directory, revision, fetch_metadata=False):
    files, blueprints, gaps, gitlinks, submodule_settings = [], [], [], [], {}
    listing = git(directory, "ls-tree", "-r", "-z", revision)
    entries = []
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        metadata, rawname = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        name = rawname.decode()
        if kind == "commit":
            gitlinks.append({"path": name, "revision": oid})
            gaps.append({"path": name, "revision": oid, "reason": "Nested Git repository; requires separate pinned source inventory"})
        if kind != "blob" or not build_definition(name):
            continue
        entries.append((name, mode, oid))
    if fetch_metadata and entries:
        hashes = list(dict.fromkeys(oid for _, _, oid in entries))
        available = subprocess.check_output(["git", "-C", str(directory), "cat-file", "--batch-check"],
            env=ENV, input=("\n".join(hashes) + "\n").encode(), timeout=30).decode().splitlines()
        missing = [line.split()[0] for line in available if line.endswith(" missing")]
        fetch_metadata_objects(directory, missing)
    # One object read avoids spawning Git once for every declaration in large
    # release trees. Missing and malformed objects still produce explicit gaps.
    objects = {}
    if entries:
        hashes = list(dict.fromkeys(oid for _, _, oid in entries))
        output = subprocess.check_output(["git", "-C", str(directory), "cat-file", "--batch"],
            env=ENV, input=("\n".join(hashes) + "\n").encode(), timeout=120)
        offset = 0
        for oid in hashes:
            end = output.index(b"\n", offset)
            header = output[offset:end].decode().split()
            offset = end + 1
            if len(header) == 3 and header[1] == "blob":
                size = int(header[2])
                objects[oid] = output[offset:offset + size]
                offset += size + 1
    for name, mode, oid in entries:
        row = {"path": name, "gitObject": oid, "mode": mode}
        files.append(row)
        try:
            if oid not in objects:
                raise OSError("Git blob is unavailable: " + oid)
            data = objects[oid]
            row["sha256"] = hashlib.sha256(data).hexdigest()
            if mode == "120000":
                row["symlinkTarget"] = data.decode()
                try:
                    resolved = resolve_source_metadata(directory, revision, name, fetch_metadata)
                except ValueError as error:
                    row["status"] = "unresolved-symlink"
                    gaps.append({"path": name, "reason": "Build-definition symlink requires cross-source resolution", "error": str(error)})
                    continue
                row["resolvedSource"] = {key: value for key, value in resolved.items() if key != "contents"}
                data = resolved["contents"].encode()
            if PurePosixPath(name).name == ".gitmodules":
                sections = submodule_declarations(directory, revision, name)
                for section, properties in sections.items():
                    if "path" in properties:
                        relative = str(PurePosixPath(name).parent / properties["path"])
                        submodule_settings[relative] = {"name": section, "declaration": name, **properties}
                row["status"] = "gitlinks-recorded"
                row["submodules"] = dict(sections)
            elif name.endswith(".bp"):
                blueprints.append({"file": name, "source": data.decode()})
            elif name.endswith(".mk"):
                # Make modules are registrations in the original evaluated
                # ALL_MODULES table. Literal LOCAL_MODULE parsing cannot model
                # included files, macro expansion or target variants.
                row["status"] = "original-kati-input"
                gaps.append({"path": name, "reason": "Make module ownership comes from the original product Kati evaluation"})
            else:
                row["status"] = "definition-recorded"
                gaps.append({"path": name, "reason": "Build definition recorded; module evaluation for this build language is not implemented"})
        except (subprocess.SubprocessError, OSError, UnicodeError) as error:
            row["status"] = "unavailable"
            gaps.append({"path": name, "reason": "Pinned build definition is unavailable locally", "error": str(error)})
    parsed = parse_blueprints(blueprints)
    modules = []
    for document in parsed:
        if "error" in document:
            gaps.append({"path": document["file"], "reason": "Blueprint could not be parsed", "error": document["error"]})
        else:
            for module in document["modules"]:
                modules.append(module)
            for row in files:
                if row["path"] == document["file"]:
                    row["status"] = "parsed"
                    row["assignments"] = document["assignments"]
    for link in gitlinks:
        link.update(submodule_settings.get(link["path"], {}))
        if "url" not in link:
            gaps.append({"path": link["path"], "reason": "Pinned Gitlink has no matching original .gitmodules URL"})
    return {"definitions": files, "modules": modules, "gaps": gaps, "gitlinks": gitlinks,
            "blueprintParser": blueprint_parser_identity(os.environ["ANDROID_BLUEPRINT_PARSER"]) if blueprints else None,
            "treeSha256": hashlib.sha256(listing).hexdigest(),
            "treeEntryCount": len([entry for entry in listing.split(b"\0") if entry]),
            "recursiveTreeComplete": True,
            "moduleDeclarationEnumerationComplete": not gaps,
            "moduleVariantEvaluationComplete": False,
            "moduleUniverseComplete": False}


def refresh_blueprint_scans(report, output, jobs=4):
    """Replace all cached Blueprint declarations using the original parser.

    Tree identities, recursive Gitlink ownership, other build languages and
    existing artifact evidence are preserved verbatim.
    """
    sources = [source for category in ("releaseSources", "nestedSources", "consumedSources")
               for source in report.get(category, []) if "scan" in source and "checkout" in source]
    identity = blueprint_parser_identity(os.environ["ANDROID_BLUEPRINT_PARSER"])
    def refresh(source):
        scan = source["scan"]
        definitions = [row for row in scan["definitions"] if row["path"].endswith(".bp")
                       and row.get("status") not in ("unavailable", "unresolved-symlink")]
        if not definitions:
            return source
        hashes = list(dict.fromkeys(row.get("resolvedSource", row)["gitObject"] for row in definitions))
        data = subprocess.check_output(["git", "-C", source["checkout"], "cat-file", "--batch"], env=ENV,
            input=("\n".join(hashes) + "\n").encode(), timeout=120)
        offset, objects = 0, {}
        for oid in hashes:
            end = data.index(b"\n", offset)
            header = data[offset:end].decode().split()
            if len(header) != 3 or header[:2] != [oid, "blob"]:
                raise RuntimeError("Original cached Blueprint blob unavailable: " + oid)
            offset = end + 1
            size = int(header[2])
            objects[oid] = data[offset:offset + size]
            offset += size + 1
        documents = [{"file": row["path"], "source": objects[row.get("resolvedSource", row)["gitObject"]].decode()}
                     for row in definitions]
        parsed = parse_blueprints(documents)
        names = {row["path"] for row in definitions}
        scan["modules"] = [module for module in scan["modules"] if module["location"]["file"] not in names]
        scan["gaps"] = [gap for gap in scan["gaps"] if not (gap.get("path") in names and gap["reason"] == "Blueprint could not be parsed")]
        indexed = {row["path"]: row for row in definitions}
        for document in parsed:
            row = indexed[document["file"]]
            if "error" in document:
                row["status"] = "parse-error"
                scan["gaps"].append({"path": document["file"], "reason": "Blueprint could not be parsed", "error": document["error"]})
            else:
                row.update(status="parsed", assignments=document["assignments"])
                for module in document["modules"]:
                    module["decision"] = module_decision(module)
                    scan["modules"].append(module)
        scan["blueprintParser"] = identity
        scan["moduleDeclarationEnumerationComplete"] = not scan["gaps"]
        return source
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        for index, _ in enumerate(pool.map(refresh, sources), 1):
            if index % 50 == 0 or index == len(sources):
                print(json.dumps({"originalBlueprintSourcesRefreshed": index, "total": len(sources)}), flush=True)
    for category, key in (("release-sources", "releaseSources"), ("nested-sources", "nestedSources")):
        for source in report[key]:
            path = output / category / (source["projectPath"].replace("/", "__") + ".json")
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(source, indent=2) + "\n")
            temporary.replace(path)
    report["ownershipCoverage"] = ownership_coverage(report["releaseSources"] + report["nestedSources"])
    temporary = output / "inventory.json.tmp"
    temporary.write_text(json.dumps(report, indent=2) + "\n")
    temporary.replace(output / "inventory.json")
    (output / "inventory.md").write_text(markdown(report))
    return report


def acquire_release_checkout(project, cache, base_url):
    """Fetch one shallow release tree and no implementation blobs/checkouts.

    The cache is a private acquisition area. Neither consumed supplier lists
    nor project inclusion decisions influence this complete manifest traversal.
    """
    relative = PurePosixPath(project["name"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Invalid manifest project name: " + project["name"])
    directory = cache / relative
    directory.mkdir(parents=True, exist_ok=True)
    repository = project.get("repository", base_url.rstrip("/") + "/" + project["name"])
    marker = directory / "release.json"
    try:
        previous = json.loads(marker.read_text())
        if previous["repository"] == repository and previous["requestedRevision"] == project["revision"]:
            git(directory, "cat-file", "-e", previous["revision"] + "^{tree}")
            return directory, repository, previous["revision"]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    subprocess.run(["git", "init", "--quiet", "--bare", str(directory)], check=True, env=ENV)
    for key, value in (("remote.origin.url", repository), ("remote.origin.promisor", "true"),
                       ("remote.origin.partialclonefilter", "blob:none")):
        subprocess.run(["git", "-C", str(directory), "config", key, value], check=True, env=ENV)
    command = ["git", "-C", str(directory), "-c", "protocol.version=2", "fetch", "--quiet",
               "--depth=1", "--filter=blob:none", "--no-tags", "--no-auto-maintenance", "origin",
               "+" + project["revision"] + ":refs/inventory/release"]
    failure = None
    for attempt in range(3):
        try:
            subprocess.run(command, check=True, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
            failure = None
            break
        except subprocess.CalledProcessError as error:
            failure = RuntimeError(error.stderr.decode(errors="replace").strip())
        except subprocess.TimeoutExpired as error:
            failure = error
        time.sleep(2 ** attempt)
    if failure:
        raise failure
    revision = git(directory, "rev-parse", "refs/inventory/release^{commit}").decode().strip()
    marker.write_text(json.dumps({"repository": repository, "requestedRevision": project["revision"],
                                 "revision": revision}, indent=2) + "\n")
    return directory, repository, revision


def acquire_release_sources(manifest, cache, output, jobs=4, base_url="https://android.googlesource.com"):
    """Checkpoint every exact release source; failures never count as empty."""
    cache, output = cache.resolve(), output.resolve()
    if cache.is_relative_to(ROOT / "src/external"):
        raise ValueError("Release metadata acquisition must not modify src/external")
    output.mkdir(parents=True, exist_ok=True)
    def one(project):
        destination = output / (project["path"].replace("/", "__") + ".json")
        try:
            previous = json.loads(destination.read_text())
            if (previous.get("requestedRevision") == project["revision"]
                    and previous.get("acquisitionSchema") == 2 and "scan" in previous
                    and (not any(row["path"].endswith(".bp") for row in previous["scan"]["definitions"])
                         or previous["scan"].get("blueprintParser") == blueprint_parser_identity(os.environ["ANDROID_BLUEPRINT_PARSER"]))
                    and all(row.get("status") != "unavailable" for row in previous["scan"]["definitions"])
                    and all(row.get("mode") != "120000" or "resolvedSource" in row or row.get("status") == "unresolved-symlink"
                            for row in previous["scan"]["definitions"])
                    and all("offset" in module["location"] for module in previous["scan"]["modules"])):
                return previous
        except (OSError, ValueError):
            pass
        row = {"id": project.get("id", project["name"]), "projectPath": project["path"],
               "requestedRevision": project["revision"], "acquisitionSchema": 2,
               "status": "source-unavailable"}
        try:
            directory, repository, revision = acquire_release_checkout(project, cache, base_url)
            row.update(checkout=str(directory), repository=repository, revision=revision)
            listing = git(directory, "ls-tree", "-r", "-z", revision)
            tree_file = destination.with_suffix(".tree.z")
            tree_file.write_bytes(zlib.compress(listing))
            row["sourceTree"] = {"path": str(tree_file), "format": "zlib-compressed git ls-tree -r -z",
                                 "sha256": hashlib.sha256(listing).hexdigest()}
            scan = inspect_repository(directory, revision, fetch_metadata=True)
            for module in scan["modules"]:
                module["decision"] = module_decision(module)
            row.update(status="scanned", scan=scan)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            row["error"] = str(error)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(row, indent=2) + "\n")
        temporary.replace(destination)
        return row
    records = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(one, project): project for project in manifest["projects"]}
        for future in concurrent.futures.as_completed(futures):
            row = future.result()
            records[row["projectPath"]] = row
            print(json.dumps({"finished": len(records), "total": len(futures), "project": row["projectPath"],
                  "status": row["status"], "modules": len(row.get("scan", {}).get("modules", [])),
                  "gaps": len(row.get("scan", {}).get("gaps", []))}), flush=True)
    sources = [records[project["path"]] for project in manifest["projects"]]
    for project, source in zip(manifest["projects"], sources):
        project["releaseSource"] = source["id"]
        project["releaseCoverage"] = ("recursive tree and build declarations scanned" if "scan" in source
                                      else "release source unavailable")
    return sources


def normalize_gitlink_url(repository, url):
    """Resolve original Git-relative URLs, using public HTTPS transport only."""
    if url.startswith(("../", "./")):
        url = urllib.parse.urljoin(repository.rstrip("/") + "/", url)
    scp = re.fullmatch(r"git@([^/:]+):(.+)", url)
    if scp:
        url = "https://" + scp[1] + "/" + scp[2]
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme in ("git", "ssh"):
        parsed = parsed._replace(scheme="https", netloc=parsed.hostname or "")
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.hostname in ("localhost", "127.0.0.1", "::1")):
        raise ValueError("Nested source does not declare a public HTTPS repository: " + url)
    return urllib.parse.urlunsplit(parsed)


def read_source_metadata(directory, revision, filename, fetch_metadata=True):
    listing = git(directory, "ls-tree", "-z", revision, "--", filename)
    if not listing:
        return None
    metadata, actual = listing.rstrip(b"\0").split(b"\t", 1)
    mode, kind, oid = metadata.decode().split()
    if kind != "blob" or actual.decode() != filename:
        raise ValueError("Expected an exact source metadata file: " + filename)
    try:
        data = git(directory, "cat-file", "blob", oid)
    except subprocess.SubprocessError:
        if not fetch_metadata:
            raise
        fetch_metadata_objects(directory, [oid])
        data = git(directory, "cat-file", "blob", oid)
    return {"path": filename, "mode": mode, "gitObject": oid, "sha256": hashlib.sha256(data).hexdigest(), "contents": data.decode()}


def resolve_source_metadata(directory, revision, filename, fetch_metadata=False, ancestry=()):
    if filename in ancestry:
        raise ValueError("Build-definition symlink cycle: " + filename)
    row = read_source_metadata(directory, revision, filename, fetch_metadata)
    if row is None:
        raise ValueError("Pinned metadata symlink target is absent: " + filename)
    if row["mode"] != "120000":
        return row
    target = row["contents"]
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(filename), target))
    if PurePosixPath(target).is_absolute() or resolved == ".." or resolved.startswith("../"):
        raise ValueError("Build-definition symlink crosses its pinned source repository: " + filename + " -> " + target)
    result = resolve_source_metadata(directory, revision, resolved, fetch_metadata, (*ancestry, filename))
    result.setdefault("symlinkChain", []).insert(0, {key: value for key, value in row.items() if key != "contents"})
    return result


def metadata_git_origins(text):
    """Read both original external_updater METADATA Git identifier formats."""
    origins = []
    for match in re.finditer(r"\b(identifier|url)\s*\{([^{}]*)\}", text, re.S):
        kind, block = match.groups()
        fields = {key: json.loads(value) if value.startswith('"') else value
                  for key, value in re.findall(r'\b(type|value|version)\s*:\s*("(?:[^"\\]|\\.)*"|[A-Za-z_]+)', block)}
        if fields.get("type", "").lower() == "archive" and fields.get("value"):
            # A publisher's GitHub source archive encodes its repository and
            # exact ref. Preserve that explicit identity; never infer from a
            # homepage or a component name.
            archive = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/archive/(.+)\.(zip|tar\.gz)", fields["value"])
            if archive:
                origins.append({"repository": "https://github.com/" + archive[1],
                    "revision": urllib.parse.unquote(archive[2]), "archive": fields["value"]})
            continue
        if fields.get("type", "").lower() != "git" or not fields.get("value"):
            continue
        version = fields.get("version")
        if not version and kind == "url":
            versions = re.findall(r'\bversion\s*:\s*("(?:[^"\\]|\\.)*")', text)
            version = json.loads(versions[0]) if len(versions) == 1 else None
        if version:
            origins.append({"repository": fields["value"], "revision": version})
    return origins


def resolve_missing_gitlink_urls(sources, cache):
    """Recover omitted .gitmodules only from a matching pinned publisher tree.

    AOSP import metadata supplies the upstream revision. A URL is accepted only
    after the upstream link's exact path and commit match the imported Gitlink.
    No project-name URL inference or current upstream branch is used.
    """
    for source in sources:
        missing = [link for link in source.get("scan", {}).get("gitlinks", []) if "url" not in link]
        if not missing or "checkout" not in source:
            continue
        try:
            metadata = read_source_metadata(source["checkout"], source["revision"], "METADATA")
            if not metadata:
                continue
            source["publisherMetadata"] = metadata
            for origin in metadata_git_origins(metadata["contents"]):
                repository = normalize_gitlink_url(source["repository"], origin["repository"])
                digest = hashlib.sha256((repository + "\0" + origin["revision"]).encode()).hexdigest()
                directory, _, revision = acquire_release_checkout({"name": "publisher-metadata/" + digest,
                    "repository": repository, "revision": origin["revision"]}, cache, "")
                declarations = read_source_metadata(directory, revision, ".gitmodules")
                if not declarations:
                    continue
                settings = {entry["path"]: entry for entry in submodule_declarations(directory, revision).values() if "path" in entry}
                for link in missing:
                    setting = settings.get(link["path"])
                    if not setting or "url" not in setting:
                        continue
                    actual = git(directory, "ls-tree", "-z", revision, "--", link["path"])
                    expected = ("160000 commit " + link["revision"] + "\t" + link["path"] + "\0").encode()
                    if actual != expected:
                        continue
                    link.update(url=normalize_gitlink_url(repository, setting["url"]), declaration=".gitmodules",
                        publisherDeclaration={"repository": repository, "revision": revision,
                                              "identifier": origin,
                                              "metadataGitObject": metadata["gitObject"],
                                              "gitmodulesGitObject": declarations["gitObject"],
                                              "gitmodulesSha256": declarations["sha256"], "pathAndCommitMatched": True})
                    source["scan"]["gaps"] = [gap for gap in source["scan"]["gaps"]
                        if not (gap.get("path") == link["path"] and gap["reason"] == "Pinned Gitlink has no matching original .gitmodules URL")]
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            source.setdefault("metadataResolutionErrors", []).append(str(error))


def acquire_nested_sources(sources, cache, output, jobs=4):
    """Follow actual pinned Gitlinks, preserving parents and deduplicating cycles."""
    known = {(canonical(source["repository"]), source["revision"]): source
             for source in sources if "repository" in source and "revision" in source}
    pending, nested = list(sources), []
    while pending:
        resolve_missing_gitlink_urls(pending, cache)
        projects, parents = [], collections.defaultdict(list)
        for parent in pending:
            for link in parent.get("scan", {}).get("gitlinks", []):
                if "url" not in link:
                    link["acquisitionStatus"] = "missing-original-url"
                    continue
                try:
                    repository = normalize_gitlink_url(parent["repository"], link["url"])
                except ValueError as error:
                    link.update(acquisitionStatus="unavailable", error=str(error))
                    continue
                identity = (canonical(repository), link["revision"])
                relation = {"source": parent["id"], "parentRevision": parent["revision"],
                            "path": link["path"], "revision": link["revision"],
                            "declaration": link["declaration"], "originalUrl": link["url"]}
                if identity in known:
                    target = known[identity]
                    link.update(source=target["id"], acquisitionStatus=target["status"])
                    if target.get("sourceKind") == "gitlink" and relation not in target["parents"]:
                        target["parents"].append(relation)
                    continue
                digest = hashlib.sha256((identity[0] + "\0" + identity[1]).encode()).hexdigest()
                source_id = "git+" + identity[0] + "@" + identity[1]
                link.update(source=source_id, acquisitionStatus="pending")
                if identity not in parents:
                    projects.append({"id": source_id, "name": "nested/" + digest,
                                     "path": "gitlinks/" + digest, "revision": link["revision"],
                                     "repository": repository})
                parents[identity].append(relation)
        if not projects:
            break
        pending = acquire_release_sources({"projects": projects}, cache, output, jobs)
        for source in pending:
            identity = (canonical(source.get("repository", next(project["repository"] for project in projects if project["path"] == source["projectPath"]))),
                        source.get("revision", source["requestedRevision"]))
            source.update(sourceKind="gitlink", parents=parents[identity])
            known[identity] = source
            nested.append(source)
    for parent in [*sources, *nested]:
        for link in parent.get("scan", {}).get("gitlinks", []):
            target = next((source for source in known.values() if source["id"] == link.get("source")), None)
            if target:
                link["acquisitionStatus"] = target["status"]
                if target["status"] == "scanned":
                    parent["scan"]["gaps"] = [gap for gap in parent["scan"].get("gaps", [])
                        if not (gap.get("path") == link["path"] and gap["reason"] == "Nested Git repository; requires separate pinned source inventory")]
    return nested


def module_decision(module):
    """Only intrinsic build roles justify exclusion; no module-name allowlist."""
    kind = module["type"]
    if re.search(r"(^|_)(test|tests|benchmark|fuzz|fuzzer)(_|$)", kind):
        return {"include": False, "reason": "Upstream test/benchmark build role; not runtime implementation", "status": "development-only"}
    if kind in ("package", "license", "license_kind", "soong_namespace"):
        return {"include": False, "reason": "Build metadata, not an executable runtime module", "status": "metadata-retained"}
    return {"include": None, "reason": "Production/build candidate; dependency and host ownership resolution required", "status": "not-established"}


def release_sources(manifest, available, fetch_metadata=False):
    """Discover release components independently of what the runtime consumes.

    Matching an existing supplier is build evidence, not a prerequisite for
    discovering an upstream module. Missing checkouts remain explicit gaps;
    this read-only inventory never downloads whole release projects implicitly.
    """
    sources = []
    for project in manifest["projects"]:
        row = {"id": project["name"], "projectPath": project["path"],
               "requestedRevision": project["revision"], "status": "source-unavailable"}
        for repository, directories in available.items():
            if not canonical(repository).endswith("/" + project["name"]):
                continue
            for directory in directories:
                try:
                    revision = git(directory, "rev-parse", project["revision"] + "^{commit}").decode().strip()
                    fetch = fetch_metadata and not directory.resolve().is_relative_to(ROOT / "src/external")
                    scan = inspect_repository(directory, revision, fetch_metadata=fetch)
                except (subprocess.SubprocessError, OSError) as error:
                    row.setdefault("attempts", []).append({"checkout": str(directory), "error": str(error)})
                    continue
                for module in scan["modules"]:
                    module["decision"] = module_decision(module)
                row.update(repository=repository, revision=revision, status="scanned",
                           checkout=str(directory), scan=scan)
                break
            if "scan" in row:
                break
        project["releaseSource"] = row["id"]
        project["releaseCoverage"] = "exact release scanned" if "scan" in row else "release source unavailable"
        sources.append(row)
    return sources


def ownership_coverage(sources):
    """Every unresolved production identity stays visible, including omissions."""
    unresolved = []
    for source in sources:
        for module in source.get("scan", {}).get("modules", []):
            if module["decision"]["include"] is None:
                unresolved.append({"source": source["id"], "revision": source.get("revision"),
                    "module": module["properties"].get("name"), "type": module["type"],
                    "location": module["location"], "decision": module["decision"]})
    return {"scannedSources": sum("scan" in source for source in sources),
            "recursiveTreesComplete": sum(source.get("scan", {}).get("recursiveTreeComplete", False) for source in sources),
            "moduleDeclarationsComplete": sum(source.get("scan", {}).get("moduleDeclarationEnumerationComplete", False) for source in sources),
            "moduleUniversesComplete": sum(source.get("scan", {}).get("moduleUniverseComplete", False) for source in sources),
            "definitionCoverageGaps": [{"source": source["id"], "revision": source.get("revision"), **gap}
                                       for source in sources for gap in source.get("scan", {}).get("gaps", [])],
            "unavailableSources": [source["id"] for source in sources if "scan" not in source],
            "unresolvedProductionModules": unresolved}


def artifact_inventory(file):
    with zipfile.ZipFile(file) as archive:
        entries = sorted(item.filename for item in archive.infolist() if not item.is_dir())
    return {"path": str(file), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "entries": entries, "classCount": sum(name.endswith(".class") for name in entries)}


def delivery_inventory(build, staged=None):
    receipt = json.loads((build / "build-receipt.json").read_text())
    products = []
    for product in receipt["products"]:
        row = dict(product)
        if staged:
            target = staged / product["path"]
            row["delivery"] = "absent" if not target.is_file() else (
                "matching" if hashlib.sha256(target.read_bytes()).hexdigest() == product.get("sha256") else "different")
        products.append(row)
    sources = []
    for file in sorted((build / "notices").rglob("source.json")):
        sources.append({"path": str(file.relative_to(build)), "declaration": json.loads(file.read_text())})
    return {"sourceHash": receipt["sourceHash"], "products": products, "sourceDeclarations": sources}


def apply_build_evidence(sources, delivery):
    for record in delivery["sourceDeclarations"]:
        declaration = record["declaration"]
        for project in sources:
            if (canonical(declaration.get("url", "")) != canonical(project.get("repository", ""))
                    or declaration.get("revision") != project.get("revision") or "scan" not in project):
                continue
            for actual in declaration.get("modules", []):
                if not isinstance(actual, dict):
                    continue
                location = actual.get("manifest") or (actual.get("path", "") + "/Android.bp")
                for module in project["scan"]["modules"]:
                    if module["properties"].get("name") == actual.get("name") and module["location"]["file"] == location:
                        module["decision"] = {"include": True, "reason": "Actual build records this upstream module; source dispositions retained in build evidence",
                                              "status": "compiled-module-boundary", "evidence": record["path"], "sourceDispositions": actual.get("sources", [])}


def markdown(report):
    projects = report["manifest"]["projects"]
    lines = ["# Generated Android upstream inventory", "",
             "Generated identities are descriptive developer data, never runtime admission rules.", "",
             f"Manifest revision: `{report['manifest']['revision']}`. Projects: {len(projects)}.",
             f"Scanned source revisions: {sum('scan' in p for p in report['consumedSources'])}.",
             f"Manifest directive gaps: {len(report['manifest']['gaps'])}.", "",
             "A project without a module scan is **unexamined**, not empty or excluded. Inclusion is distinct from implementation.", "",
             "| Project | Release revision | Consumed source pins | Module coverage |",
             "| --- | --- | --- | --- |"]
    escape = lambda value: str(value).replace("|", "\\|").replace("\n", " ")
    for project in projects:
        matched = project["consumedSources"]
        lines.append("| " + " | ".join(map(escape, [project["name"], project["revision"], ", ".join(matched), project["coverage"]])) + " |")
    if "releaseSources" in report:
        coverage = report["ownershipCoverage"]
        lines.extend(["", "Release discovery is independent of consumed suppliers.",
                      f"Exact release sources scanned: {coverage['scannedSources']}; unavailable: {len(coverage['unavailableSources'])}.",
                      f"Unresolved release production modules: {len(coverage['unresolvedProductionModules'])}."])
    for project in report["consumedSources"] + report.get("releaseSources", []) + report.get("nestedSources", []):
        lines.extend(["", "## " + project["id"], "", f"Revision: `{project.get('revision', project.get('requestedRevision'))}`. Status: {project['status']}."])
        if "scan" not in project:
            continue
        scan = project["scan"]
        lines.extend(["", f"Build definitions: {len(scan['definitions'])}; modules: {len(scan['modules'])}; coverage gaps: {len(scan['gaps'])}.", "",
                      "| Module | Type | Include | Reason |", "| --- | --- | --- | --- |"])
        for module in scan["modules"]:
            decision = module["decision"]
            values = [module["properties"].get("name", module["location"]), module["type"],
                      {True: "yes", False: "no", None: "unresolved"}[decision["include"]], decision["reason"]]
            lines.append("| " + " | ".join(map(escape, values)) + " |")
        for gap in scan["gaps"]:
            lines.append("\n- " + escape(gap))
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--manifest-revision")
    parser.add_argument("--checkout-root", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--refresh-blueprint-parser", type=Path, help="Rebuild the parser transport over its existing pinned package")
    parser.add_argument("--go", default="go")
    parser.add_argument("--framework", type=Path)
    parser.add_argument("--build", type=Path)
    parser.add_argument("--staged", type=Path)
    parser.add_argument("--fetch-metadata", action="store_true", help="Fetch only missing build-definition Git blobs into supplied checkouts")
    parser.add_argument("--acquire-release-cache", type=Path,
        help="Explicitly acquire every manifest project's recursive Git tree and build metadata into this private bare-repository cache")
    parser.add_argument("--metadata-jobs", type=int, default=4)
    parser.add_argument("--blueprint-parser", type=Path, help="Original Blueprint parser executable; otherwise acquired releases bootstrap it automatically")
    parser.add_argument("--refresh-blueprints", action="store_true", help="Refresh every cached Blueprint declaration from --base-inventory with the original parser")
    parser.add_argument("--base-inventory", type=Path,
        help="Retain an existing consumed-source/artifact scan while independently enumerating the full same-release source universe")
    args = parser.parse_args()
    if args.refresh_blueprint_parser:
        refresh_blueprint_parser(args.refresh_blueprint_parser, args.go)
        return
    if not all((args.manifest, args.manifest_revision, args.output)):
        parser.error("--manifest, --manifest-revision and --output are required for inventory generation")
    if not re.fullmatch(r"[0-9a-f]{40}", args.manifest_revision):
        parser.error("--manifest-revision must be an exact Git commit")
    if not 1 <= args.metadata_jobs <= 16:
        parser.error("--metadata-jobs must be between 1 and 16")
    upstreams = json.loads((ROOT / "scripts/upstream-overlays.json").read_text())["projects"]
    consumed = [p for p in upstreams if any(r["path"].startswith("src/modules/android/") for r in p.get("pinRefs", []))]
    manifest = manifest_projects(args.manifest, args.manifest_revision)
    if args.blueprint_parser:
        os.environ["ANDROID_BLUEPRINT_PARSER"] = str(args.blueprint_parser.resolve())
    elif not os.environ.get("ANDROID_BLUEPRINT_PARSER") and args.acquire_release_cache:
        os.environ["ANDROID_BLUEPRINT_PARSER"] = bootstrap_blueprint_parser(manifest, args.acquire_release_cache, args.output / "blueprint-parser")
    available = checkouts(args.checkout_root + [ROOT / p["path"] for p in consumed if (ROOT / p["path"] / ".git").exists()])
    base = json.loads(args.base_inventory.read_text()) if args.base_inventory else None
    if base and base["manifest"]["revision"] != args.manifest_revision:
        parser.error("--base-inventory must describe this exact manifest revision")
    if args.refresh_blueprints:
        if not base:
            parser.error("--refresh-blueprints requires --base-inventory")
        refresh_blueprint_scans(base, args.output, args.metadata_jobs)
        return
    sources = base["consumedSources"] if base else []
    for pin in ([] if base else consumed):
        row = {key: pin[key] for key in ("id", "repository", "revision")}
        row["status"] = "source-unavailable"
        for directory in available[canonical(pin["repository"])]:
            try:
                # src/external remains read-only, even with explicit acquisition.
                fetch = args.fetch_metadata and not directory.resolve().is_relative_to(ROOT / "src/external")
                scan = inspect_repository(directory, pin["revision"], fetch_metadata=fetch)
            except (subprocess.SubprocessError, OSError) as error:
                row.setdefault("attempts", []).append({"checkout": str(directory), "error": str(error)})
                continue
            row.update(status="scanned", checkout=str(directory), scan=scan)
            for module in scan["modules"]:
                module["decision"] = module_decision(module)
            break
        sources.append(row)
        print(f"{row['id']}: {row['status']}" + (f", {len(row['scan']['modules'])} modules, {len(row['scan']['gaps'])} gaps" if "scan" in row else ""), flush=True)
    for project in manifest["projects"]:
        # The release manifest and consumed artifact revisions need not be equal.
        # Preserve both, never infer compatibility or coverage from matching names.
        matches = [row for row in sources if canonical(row["repository"]).endswith("/" + project["name"])]
        project["consumedSources"] = [row["id"] for row in matches]
        project["coverage"] = "consumed revisions scanned separately" if any("scan" in row for row in matches) else "unexamined"
    release = (acquire_release_sources(manifest, args.acquire_release_cache,
                                      args.output / "release-sources", args.metadata_jobs)
               if args.acquire_release_cache else release_sources(manifest, available, args.fetch_metadata))
    nested = (acquire_nested_sources(release, args.acquire_release_cache, args.output / "nested-sources", args.metadata_jobs)
              if args.acquire_release_cache else [])
    if args.acquire_release_cache:
        # Link resolutions are attached after traversal. Persist them in the
        # same source checkpoint, including all aliases and exact parent paths.
        for category, records in (("release-sources", release), ("nested-sources", nested)):
            for record in records:
                target = args.output / category / (record["projectPath"].replace("/", "__") + ".json")
                target.write_text(json.dumps(record, indent=2) + "\n")
    report = {"schemaVersion": 2, "manifest": manifest, "consumedSources": sources,
              "releaseSources": release, "nestedSources": nested}
    if args.framework:
        report["framework"] = artifact_inventory(args.framework)
    if args.build:
        report["delivery"] = delivery_inventory(args.build, args.staged)
        apply_build_evidence(sources, report["delivery"])
        apply_build_evidence(release, report["delivery"])
        apply_build_evidence(nested, report["delivery"])
    report["ownershipCoverage"] = ownership_coverage(release + nested)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "inventory.json").write_text(json.dumps(report, indent=2) + "\n")
    (args.output / "inventory.md").write_text(markdown(report))
    print(json.dumps({"projects": len(manifest["projects"]), "sources": len(sources),
                      "scanned": sum("scan" in p for p in sources), "nestedSources": len(nested), "output": str(args.output)}))


if __name__ == "__main__":
    main()
