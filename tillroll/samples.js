// The source photographs serve live scans. Saved data are used only in saved sample mode.
const directories = {featured:'./featured/', photos:'./real-samples/', demo:'./samples/'};
export async function loadSamples(set = 'featured', excluded = new Set()) {
  const base = new URL(directories[set], import.meta.url);
  const response = await fetch(new URL('index.json?v=curatedphotos1',base));
  if (!response.ok) throw new Error('The sample receipt set could not be loaded.');
  const manifest = await response.json();
  const images = new Map();
  const remaining = manifest.filter(({filename})=>!excluded.has(filename));
  return Promise.all(remaining.map(async ({path,filename,data,ocr,referenceOcr,note,credit})=>{
    if (!images.has(path)) images.set(path,fetch(new URL(path,base)).then(r=>{
      if (!r.ok) throw new Error('Could not load sample receipt '+filename);
      return r.blob();
    }));
    return {file:new File([await images.get(path)],filename,{type:'image/jpeg'}),
      data,ocr,referenceOcr,note,credit,set,sample:true};
  }));
}
