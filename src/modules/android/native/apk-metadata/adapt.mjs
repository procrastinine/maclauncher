import fs from 'node:fs';
import path from 'node:path';

// Add metadata request configuration while retaining the original parser APIs.
export function adapt(directory) {
  const edit=(name,before,after)=>{const file=path.join(directory,name),text=fs.readFileSync(file,'utf8');if(!text.includes(before))throw Error('Original APK parser source changed: '+name);fs.writeFileSync(file,text.replace(before,after));};
  const file=path.join(directory,'apk.rs'),original=fs.readFileSync(file,'utf8'),begin=original.indexOf('pub struct Apk {'),end=original.indexOf("/// An app's resources:");
  if(begin<0||end<=begin)throw Error('Original APK source boundary changed');
  fs.writeFileSync(file,original.slice(0,begin)+String.raw`pub struct Apk {
    sources: Vec<Box<FileSource>>,
    table: Option<Table>,
    manifest: Element,
    locale: String,
}

fn source_file(source: &FileSource, name: &str) -> Result<Option<Vec<u8>>> {
    let archive = Archive::open(source).map_err(|e| bad(e.to_string()))?;
    let Some(entry) = archive.find(name.as_bytes()) else { return Ok(None) };
    archive.read(entry, MAX_ENTRY).map(Some).map_err(|e| bad(e.to_string()))
}

impl Apk {
    pub fn open(path: &Path) -> Result<Apk> {
        Self::open_many(&[path.to_path_buf()], "en-US")
    }

    /// The base and its verified resource/feature splits, in asset order.
    pub fn open_many(paths: &[std::path::PathBuf], locale: &str) -> Result<Apk> {
        let mut sources = Vec::new();
        let mut table: Option<Table> = None;
        let mut manifest: Option<Element> = None;
        let mut package = String::new();
        for (index, path) in paths.iter().enumerate() {
            let source = Box::new(FileSource::open(path).map_err(|e| bad(e.to_string()))?);
            let bytes = source_file(&source,"AndroidManifest.xml")?.ok_or_else(||bad("no AndroidManifest.xml"))?;
            let next = res::xml(&bytes)?;
            let Some(Value::String(name)) = next.named("package") else {return Err(bad("manifest has no package name"))};
            if index == 0 {
                if matches!(next.named("split"),Some(Value::String(s)) if !s.is_empty()) {return Err(bad("base APK must be the first source"));}
                package = name.clone();
                manifest = Some(next);
            } else {
                if *name != package {return Err(bad("split APK belongs to a different package"));}
                if !matches!(next.named("split"),Some(Value::String(s)) if !s.is_empty()) {return Err(bad("additional package source is not a split"));}
                if let Some(app) = next.children.into_iter().find(|c|c.name=="application") {
                    if let Some(base) = manifest.as_mut().and_then(|m|m.children.iter_mut().find(|c|c.name=="application")) {base.children.extend(app.children);}
                }
            }
            if let Some(bytes) = source_file(&source,"resources.arsc")? {
                let next = Table::parse(&bytes)?;
                if let Some(base) = table.as_mut() {base.append(next)} else {table=Some(next)}
            }
            sources.push(source);
        }
        Ok(Apk {sources, table, manifest:manifest.ok_or_else(||bad("no base package"))?, locale:locale.to_owned()})
    }

    pub fn file(&self, name: &str) -> Result<Vec<u8>> {
        self.file_if_present(name)?.ok_or_else(|| bad(format!("no {name}")))
    }

    pub fn file_if_present(&self, name: &str) -> Result<Option<Vec<u8>>> {
        if name == "AndroidManifest.xml" || name == "resources.arsc" {
            return source_file(&self.sources[0], name);
        }
        for source in self.sources.iter().rev() {
            if let Some(bytes) = source_file(source,name)? {return Ok(Some(bytes));}
        }
        Ok(None)
    }

    pub fn manifest(&self) -> Result<Element> { Ok(self.manifest.clone()) }
    pub fn table(&self) -> Option<&Table> { self.table.as_ref() }
}

`+original.slice(end));
  edit('apk.rs','table.get(id, self.night)?','table.get_for_locale(id, self.night, &apk.locale)?');
  edit('table.rs','    pub language: [u8; 2],','    pub language: [u8; 2],\n    pub country: [u8; 2],\n    pub script: [u8; 4],');
  edit('table.rs','            language: [byte(8), byte(9)],','            language: [byte(8), byte(9)],\n            country: [byte(10), byte(11)],\n            script: [byte(36), byte(37), byte(38), byte(39)],');
  edit('table.rs','    pub fn strings(&self) -> &Strings {',String.raw`    /// Combine resource type configurations without flattening their qualifiers.
    pub fn append(&mut self, other: Table) {
        for package in other.packages {
            if let Some(existing) = self.packages.iter_mut().find(|p|p.id==package.id) {
                for (id,types) in package.types {existing.types.entry(id).or_default().extend(types);}
            } else {self.packages.push(package);}
        }
    }

    pub fn get_for_locale(&self, id:u32, night:bool, locale:&str) -> Option<(&Entry,Config)> {
        let normalized=locale.replace('_',"-");
        let parts:Vec<_>=normalized.split('-').collect();
        let language=parts.first().copied().unwrap_or("en").to_ascii_lowercase();
        let region=parts.iter().skip(1).find(|p|p.len()==2||p.len()==3&&p.bytes().all(|b|b.is_ascii_digit())).map(|p|p.to_ascii_uppercase()).unwrap_or_default();
        let script=parts.iter().skip(1).find(|p|p.len()==4).map(|p|p.to_ascii_lowercase()).unwrap_or_default();
        fn unpack(bytes:[u8;2],base:u8)->String {
            let decoded=if bytes[0]&0x80!=0 {vec![base+(bytes[1]&0x1f),base+((bytes[1]&0xe0)>>5)+((bytes[0]&3)<<3),base+((bytes[0]&0x7c)>>2)]} else {bytes.into_iter().take_while(|b|*b!=0).collect()};
            String::from_utf8(decoded).unwrap_or_default()
        }
        let package=self.packages.iter().find(|p|p.id==(id>>24)as u8)?;
        let entry=(id&0xffff)as u16;
        package.types.get(&((id>>16)as u8))?.iter().filter_map(|t|{
            let c=t.config;
            let lang=unpack(c.language,b'a').to_ascii_lowercase();
            let country=unpack(c.country,b'0').to_ascii_uppercase();
            let configured_script=String::from_utf8_lossy(&c.script).trim_end_matches('\0').to_ascii_lowercase();
            if c.mcc!=0||c.mnc!=0||c.sdk>SDK||!c.night.is_none_or(|n|n==night)||!lang.is_empty()&&lang!=language||!country.is_empty()&&country!=region||!configured_script.is_empty()&&configured_script!=script {return None;}
            // Default entries remain the fallback; only the requested language,
            // region and explicit script can outrank them.
            let density=match c.density {DENSITY_ANY=>u32::MAX,DENSITY_NONE=>u32::MAX-1,0=>160,d=>d as u32};
            let score=(!lang.is_empty(),!country.is_empty(),!configured_script.is_empty(),c.night.is_some(),density,c.sdk);
            t.entries.get(&entry).map(|e|(e,c,score))
        }).max_by_key(|(_,_,score)|*score).map(|(e,c,_)|(e,c))
    }

    pub fn strings(&self) -> &Strings {`);
}
