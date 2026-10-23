import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("inventory", Path(__file__).resolve().parents[1] / "scripts/android-upstream-inventory.py")
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def test_publisher_metadata_requires_explicit_git_origin_and_version(self):
        current = 'third_party { identifier { type: "Git" value: "https://example.invalid/upstream" version: "abc" primary_source: true } }'
        old = 'third_party { url { type: HOMEPAGE value: "https://example.invalid/site" } url { type: GIT value: "https://example.invalid/repository" } version: "def" }'
        self.assertEqual(inventory.metadata_git_origins(current), [{"repository": "https://example.invalid/upstream", "revision": "abc"}])
        self.assertEqual(inventory.metadata_git_origins(old), [{"repository": "https://example.invalid/repository", "revision": "def"}])
        self.assertEqual(inventory.metadata_git_origins('identifier { type: "Archive" value: "https://example.invalid/source.tar.gz" version: "v1" }'), [])

    def test_nested_gitlinks_resolve_original_urls_and_deduplicate_cycles(self):
        a = {"id": "platform/a", "projectPath": "a", "repository": "https://example.invalid/team/a.git",
             "revision": "a" * 40, "status": "scanned", "scan": {"gitlinks": [
                 {"path": "dep", "url": "../b.git", "revision": "b" * 40, "declaration": ".gitmodules"},
                 {"path": "alias", "url": "git@example.invalid:team/b.git", "revision": "b" * 40, "declaration": ".gitmodules"}]}}
        def acquire(manifest, cache, output, jobs):
            self.assertEqual(len(manifest["projects"]), 1)
            p = manifest["projects"][0]
            self.assertEqual(p["repository"], "https://example.invalid/team/b.git")
            return [{"id": p["id"], "projectPath": p["path"], "repository": p["repository"],
                     "revision": p["revision"], "requestedRevision": p["revision"], "status": "scanned",
                     "scan": {"gitlinks": [{"path": "cycle", "url": "../a.git", "revision": "a" * 40, "declaration": ".gitmodules"}]}}]
        with patch.object(inventory, "acquire_release_sources", acquire):
            rows = inventory.acquire_nested_sources([a], Path("unused-cache"), Path("unused-output"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]["parents"]), 2)
        self.assertEqual(rows[0]["scan"]["gitlinks"][0]["source"], "platform/a")
        for unsafe in ("file:///tmp/repo", "ext::arbitrary", "https://user:secret@example.invalid/repo", "https://localhost/repo"):
            with self.assertRaises(ValueError):
                inventory.normalize_gitlink_url(a["repository"], unsafe)

    def test_release_acquisition_scans_nested_unconsumed_definitions_and_records_language_gaps(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "remote/platform/new-family"
            nested = source / "deep/independent"
            nested.mkdir(parents=True)
            (nested / "Android.bp").write_text('java_library(name = "unconsumed_service", srcs = ["**/*.java"])\n')
            (nested / "Android.mk").write_text('LOCAL_MODULE := other_service\n')
            (source / "implementation.txt").write_text("source identity retained without executing implementation")
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Inventory Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
            project = {"name": "platform/new-family", "path": "packages/modules/NewFamily", "revision": revision}
            result = inventory.acquire_release_sources({"projects": [project]}, root / "cache", root / "output", jobs=1, base_url=str(root / "remote"))
            row = result[0]
            self.assertEqual(row["revision"], revision)
            self.assertEqual(row["scan"]["modules"][0]["properties"]["name"], "unconsumed_service")
            self.assertEqual(row["scan"]["blueprintParser"]["implementation"], "original-blueprint")
            self.assertTrue(row["scan"]["recursiveTreeComplete"])
            make = next(value for value in row["scan"]["definitions"] if value["path"].endswith("Android.mk"))
            self.assertEqual(make["status"], "original-kati-input")
            self.assertTrue(make["sha256"])
            self.assertTrue(make["gitObject"])
            self.assertFalse(any(module.get("language") == "android-make" for module in row["scan"]["modules"]))
            self.assertFalse(row["scan"]["moduleUniverseComplete"])
            self.assertEqual(row["scan"]["treeEntryCount"], 3)
            self.assertEqual(len(row["scan"]["gaps"]), 1)
            self.assertTrue(Path(row["sourceTree"]["path"]).is_file())
            # The source checkout stays unchanged and no module is admitted or
            # selected by the developer inventory.
            self.assertEqual(subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True), "")
            self.assertIsNone(row["scan"]["modules"][0]["decision"]["include"])

    def test_release_module_discovery_does_not_require_a_consuming_supplier(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "Android.bp").write_text('java_library {name: "whole_service_family", srcs: ["**/*.java"]}\n')
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Inventory Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
            project = {"name": "platform/packages/modules/NewFamily", "path": "packages/modules/NewFamily", "revision": revision, "consumedSources": []}
            missing = {"name": "platform/missing", "path": "missing", "revision": revision, "consumedSources": []}
            result = inventory.release_sources({"projects": [project, missing]}, {
                "https://android.googlesource.com/platform/packages/modules/NewFamily": [root]})
            self.assertEqual(result[0]["scan"]["modules"][0]["properties"]["name"], "whole_service_family")
            self.assertEqual(project["releaseCoverage"], "exact release scanned")
            self.assertEqual(result[1]["status"], "source-unavailable")
            coverage = inventory.ownership_coverage(result)
            self.assertEqual(coverage["unavailableSources"], ["platform/missing"])
            self.assertEqual(coverage["unresolvedProductionModules"][0]["module"], "whole_service_family")

    def test_manifest_includes_nested_projects_and_keeps_unknown_directives(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "default.xml").write_text('''<manifest><remote name="aosp" fetch=".."/>
              <default revision="release" remote="aosp"/><include name="components.xml"/>
              <extend-project name="platform/a" revision="new"/>
              <submanifest name="vendor" project="vendor/manifest"/></manifest>''')
            (root / "components.xml").write_text('''<manifest><project name="platform/a" path="a">
              <project name="nested" path="child"/><linkfile src="root.bp" dest="Android.bp"/></project><project name="platform/b"/></manifest>''')
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Inventory Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            result = inventory.manifest_projects(root, "HEAD")
            self.assertEqual([p["name"] for p in result["projects"]], ["platform/a", "platform/a/nested", "platform/b"])
            self.assertEqual(result["projects"][0]["revision"], "new")
            self.assertEqual(result["projects"][1]["path"], "a/child")
            self.assertEqual(result["projects"][0]["fileMappings"], [{"kind": "linkfile", "src": "root.bp", "dest": "Android.bp"}])
            self.assertEqual(result["gaps"][0]["kind"], "submanifest")
            self.assertEqual(len(result["files"]), 2)

    def test_new_modules_are_discovered_and_parse_failures_are_visible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "Android.bp").write_text('cc_library {name: "new_component", srcs: ["owner.cpp"]}\ncc_test {name: "native_test"}\n')
            (root / "alias.bp").symlink_to("Android.bp")
            (root / "unknown.bp").write_text('this is broken')
            (root / "CMakeLists.txt").write_text('add_library(other owner.cpp)')
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Inventory Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            result = inventory.inspect_repository(root, "HEAD")
            self.assertEqual(len(result["definitions"]), 4)
            self.assertEqual([m["properties"]["name"] for m in result["modules"]], ["new_component", "native_test", "new_component", "native_test"])
            alias = next(row for row in result["definitions"] if row["path"] == "alias.bp")
            self.assertEqual(alias["resolvedSource"]["path"], "Android.bp")
            self.assertEqual(len(result["gaps"]), 2)
            self.assertIsNone(inventory.module_decision(result["modules"][0])["include"])
            self.assertFalse(inventory.module_decision(result["modules"][1])["include"])

    def test_delivery_reports_an_unstaged_new_product(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build, staged = root / "build", root / "staged"
            build.mkdir(); staged.mkdir()
            (build / "build-receipt.json").write_text(json.dumps({"sourceHash": "identity", "products": [{"path": "native/new-owner.dylib", "sha256": "digest"}]}))
            self.assertEqual(inventory.delivery_inventory(build, staged)["products"][0]["delivery"], "absent")


if __name__ == "__main__":
    unittest.main()
