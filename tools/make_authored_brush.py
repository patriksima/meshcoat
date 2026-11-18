"""Author an original numeric impasto sculpt. No memileo images/resources are sampled."""
from pathlib import Path
import base64,io,json
import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]/'impasto'/'authored-brush'
root.mkdir(parents=True,exist_ok=True)
pack={'fileName':'MeshCoat Sculpted Impasto','packName':'MeshCoat Sculpted Impasto','brushes':[]}
def url(im):
    buf=io.BytesIO();im.save(buf,format='PNG');return 'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode()
def smooth(a,b,x):
    t=np.clip((x-a)/(b-a),0,1);return t*t*(3-2*t)
for index in range(3):
    n=384;y,x=np.mgrid[:n,:n].astype(float);x=(x/(n-1)-.5)*2;y=(y/(n-1)-.5)*2
    # A flexible flat brush with longitudinal bristle furrows and irregular ends.
    rng=np.random.default_rng(4100+index)
    transverse=y+.006*np.sin(x*4+index)
    width=.43*(1-.10*x)+.018*np.sin(x*5+index)
    side=1-smooth(width*.80,width,abs(transverse))
    end=1-smooth(.72+.03*np.sin(transverse*51+index),.94,abs(x))
    footprint=side*end
    bristles=np.zeros_like(x)
    for center in np.linspace(-.39,.39,15)+rng.uniform(-.012,.012,15):
        phase=rng.uniform(0,6.28); sigma=rng.uniform(.016,.030)
        curve=center+.004*np.sin(x*rng.uniform(3,8)+phase)+.002*np.sin(x*17+phase)
        strand=np.exp(-((transverse-curve)/sigma)**2)
        strand*=rng.uniform(.12,.32)*(.72+.28*np.sin(x*rng.uniform(1,5)+phase)**2)
        strand*=1-smooth(rng.uniform(.60,.79),rng.uniform(.84,.97),abs(x))
        bristles+=strand
    lumps=np.zeros_like(x)
    for _ in range(9):
        lumps+=rng.uniform(.025,.09)*np.exp(-((x-rng.uniform(-.75,.75))/rng.uniform(.06,.2))**2-((y-rng.uniform(-.3,.3))/.05)**2)
    rim=.10*np.exp(-((abs(transverse)/np.maximum(width,.01)-.86)/.07)**2)
    h=np.clip((.24+bristles+lumps+rim)*footprint*(.94+.06*np.cos(x*3+index)),0,1)
    values=np.round(h*65535).astype(np.uint16)
    alpha=np.round(smooth(0,.055,h)*255).astype(np.uint8)
    packed=np.stack([(values>>8).astype(np.uint8),(values&255).astype(np.uint8),(values>>8).astype(np.uint8),alpha],axis=-1)
    tip=Image.fromarray(packed,'RGBA')
    height=Image.fromarray(values,'I;16');height.save(root/f'impasto-sculpt-{index+1}-height16.png')
    Image.fromarray(alpha,'L').save(root/f'impasto-sculpt-{index+1}-alpha.png')
    tip.save(root/f'impasto-sculpt-{index+1}-packed.png')
    gy,gx=np.gradient(h);normal=np.dstack([-gx*32,-gy*32,np.ones_like(h)])
    normal/=np.linalg.norm(normal,axis=2,keepdims=True)
    lit=np.clip(.35+.65*(normal@np.array([-.35,-.45,.82])),0,1)
    preview=Image.fromarray(np.dstack([(lit*210).astype('uint8')]*3+[alpha]),'RGBA')
    preview.save(root/f'impasto-sculpt-{index+1}-preview.png')
    pack['brushes'].append({'id':f'impasto-sculpt-{index+1}','name':f'MeshCoat Sculpt {index+1}','width':n,'height':n,
      'diameter':n,'spacing':.24,'dataUrl':url(tip),'previewUrl':url(preview),'packName':pack['packName'],
      'impasto':True,'authoredHeight':True})
(root/'impasto-sculpt.json').write_text(json.dumps(pack,indent=2),encoding='utf-8')
(root/'README.txt').write_text('Original analytic brush sculpt authored for MeshCoat. No memileo pixels, alpha masks or textures used. Height16 is a real authored scalar field, not brightness recovered from lighting. Packed PNG: R=height high byte, G=low byte, B=preview high byte, A=coverage. Original source algorithm is tools/make_authored_brush.py. You may use and modify these original brush assets for MeshCoat and commercial artwork.\n',encoding='utf-8')
print('Authored three original 16-bit brush sculpts:',root)
