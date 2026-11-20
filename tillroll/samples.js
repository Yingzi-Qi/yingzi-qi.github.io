// Synthetic receipt images with saved local OCR readings and illustrative extraction results.
const base = new URL('./samples/', import.meta.url);
export async function loadSamples() {
  const response = await fetch(new URL('index.json',base));
  if (!response.ok) throw new Error('The sample receipt set could not be loaded.');
  const manifest = await response.json();
  const images = new Map();
  return Promise.all(manifest.map(async ({path,filename,data,ocr,note})=>{
    if (!images.has(path)) images.set(path,fetch(new URL(path,base)).then(r=>{
      if (!r.ok) throw new Error('Could not load sample receipt '+filename);
      return r.blob();
    }));
    return {file:new File([await images.get(path)],filename,{type:'image/jpeg'}),
      data,ocr,note,sample:true};
  }));
}
