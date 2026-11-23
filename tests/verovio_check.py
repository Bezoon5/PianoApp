"""Checks that Verovio renders every fixture with SVG measures matching the app's
MusicXML measures 1:1 (bar highlighting and loop marking rely on this).
Run: pip install verovio && python3 tests/verovio_check.py"""
import json, os, re, subprocess, sys
import verovio
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
js = r'''
const fs=require('fs'),MX=require(process.argv[1]+'/music/musicxml.js');
(async()=>{const out=[];
for(const f of ['maple-leaf-rag.mxl','clara-polonaise.mxl','lindenbaum.xml','bach-bwv66.mxl','dichterliebe-2.xml']){
  const b=fs.readFileSync(process.argv[1]+'/tests/fixtures/'+f);const t=await MX.readFile(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));
  const sc=MX.parse(t),id=MX.choosePart(sc);const xml=sc.parts.length>1?MX.extractPart(t,id):t;
  out.push({name:f,xml,measures:MX.parse(xml).parts[0].measures.length});}
const carol={title:'Silent Night',bpm:72,timeSignature:[3,4],notes:[67,69,67,64,67,69,67,64].map((m,i)=>({midi:m,startBeat:i,durationBeats:0.9,hand:'right'}))};
const x=MX.songToMusicXML(carol);out.push({name:'generated carol',xml:x,measures:MX.parse(x).parts[0].measures.length});
console.log(JSON.stringify(out));})();'''
dump = subprocess.run(['node', '-e', js, ROOT], capture_output=True, text=True, check=True)
tk = verovio.toolkit(); ok = True
for item in json.loads(dump.stdout):
    tk.setOptions({'scale': 40, 'pageWidth': 2800, 'adjustPageHeight': True, 'breaks': 'auto', 'header': 'auto', 'footer': 'none'})
    loaded = tk.loadData(item['xml'])
    svg = ''.join(tk.renderToSVG(p) for p in range(1, tk.getPageCount() + 1)) if loaded else ''
    ms = re.findall(r'<g id="([^"]+)" class="measure', svg)
    seen = {e['measureOn'] for e in tk.renderToTimemap({'includeMeasures': True}) if 'measureOn' in e} if loaded else set()
    good = loaded and len(ms) == item['measures'] and all(m in seen for m in ms)
    ok &= good
    print(('PASS ' if good else 'FAIL ') + item['name'], 'svg measures', len(ms), 'musicxml measures', item['measures'])
sys.exit(0 if ok else 1)
