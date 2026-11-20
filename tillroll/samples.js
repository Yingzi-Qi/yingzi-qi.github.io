// Both sets use saved readings so sample batches open without an API key.
export async function loadSamples(set = 'demo') {
  const base = new URL(set === 'photos' ? './real-samples/' : './samples/', import.meta.url);
  const response = await fetch(new URL(set==='photos' ? 'index.json?v=4' : 'index.json',base));
  if (!response.ok) throw new Error('The sample receipt set could not be loaded.');
  const manifest = await response.json();
  const images = new Map();
  return Promise.all(manifest.map(async ({path,filename,data,ocr,referenceOcr,note,credit})=>{
    if (!images.has(path)) images.set(path,fetch(new URL(path,base)).then(r=>{
      if (!r.ok) throw new Error('Could not load sample receipt '+filename);
      return r.blob();
    }));
    return {file:new File([await images.get(path)],filename,{type:'image/jpeg'}),
      data,ocr,referenceOcr,note,credit,set,sample:true};
  }));
}
