from pathlib import Path
import numpy as np
from PIL import Image
import json,struct
root=Path(__file__).resolve().parents[1]/'impasto/height-evidence'
height=lambda name:np.array(Image.open(root/(name+'_height.png'))).astype(np.int32)
rgb=lambda name,channel:np.array(Image.open(root/(name+'_'+channel+'.png')))
flat,low,high,overlap,half=[height(s) for s in ['flat','low','high','overlap','half-layer']]
report={}
report['pngBitDepth']= (root/'high_height.png').read_bytes()[24]
assert report['pngBitDepth']==16
assert np.all(flat==32768)
assert np.array_equal(rgb('flat','albedo'),rgb('low','albedo')) and np.array_equal(rgb('low','albedo'),rgb('high','albedo'))
report['albedoIndependentOfHeight']=True
report['uniqueHeightValues']={s:int(len(np.unique(height(s)))) for s in ['flat','low','high','overlap']}
assert report['uniqueHeightValues']['high']>256
assert overlap.max()>high.max()>low.max()>32768
report['halfLayerMaxQuantizationError']=float(np.max(abs(half-(high+(overlap-high)*.5))))
assert report['halfLayerMaxQuantizationError']<=2
assert np.array_equal(height('reloaded'),overlap)
report['reloadExact']=True
assert np.any(height('erased')!=overlap)
report['eraserRemovesHeight']=True
report['heightsModelUnits']={s:float((height(s).max()-32768)/32767) for s in ['low','high','overlap']}
def sample(data,u,v):
    x=u*(data.shape[1]-1);y=(1-v)*(data.shape[0]-1);i,j=int(x),int(y);fx,fy=x-i,y-j
    return (data[j,i]*(1-fx)+data[j,i+1]*fx)*(1-fy)+(data[j+1,i]*(1-fx)+data[j+1,i+1]*fx)*fy
n=rgb('high','normal')[:,:,:3].astype(float)/255*2-1
angles=[];dheight=[]
for y in np.linspace(-.10,.10,150):
    l=(.45-.0005*.4,.5+y*.45);r=(.75+y*.2,.95-.0005*.9)
    nl,nr=sample(n,*l),sample(n,*r);nr=np.array([-nr[1],nr[0],nr[2]])
    angles.append(np.degrees(np.arccos(np.clip(nl@nr/np.linalg.norm(nl)/np.linalg.norm(nr),-1,1))))
    dheight.append(abs(sample(high,*l)-sample(high,*r))/32767)
report['rotatedUvSeam']={'meanHeightDifferenceModelUnits':float(np.mean(dheight)),'maxHeightDifferenceModelUnits':float(np.max(dheight)),
 'meanNormalAngleDegrees':float(np.mean(angles)),'maxNormalAngleDegrees':float(np.max(angles)),
 'note':'Neighboring samples +/-0.0005 model units; finite-difference normal bake is not an arbitrary-UV seam guarantee.'}
assert np.mean(dheight)<.001
assert np.mean(angles)<20
normal=rgb('flat','normal')[:,:,:3]
report['flatNormalAtCenter']=normal[normal.shape[0]//2,normal.shape[1]//4].tolist()
assert max(abs(normal[normal.shape[0]//2,normal.shape[1]//4].astype(int)-np.array([128,128,255])))<=1
tree=Image.open(root/'tree_height.png');wizard=Image.open(root/'wizard-height16.png')
assert tree.tobytes()==wizard.tobytes()
report['wizardHeightMatchesNativeExport']=True
# On the regular left panel island, u=.45+.4*x and v=.5+.45*y.
# Export rows run downward, so positive-v differences use the previous image row.
h=(high.astype(float)-32768)/32767
size=h.shape[0]
gx=(np.roll(h,-1,1)-np.roll(h,1,1))*size*.4/2
gy=(np.roll(h,1,0)-np.roll(h,-1,0))*size*.45/2
expected=np.stack([-gx,-gy,np.ones_like(h)],2)
expected/=np.linalg.norm(expected,axis=2)[:,:,None]
region=(slice(int(size*.3),int(size*.7)),slice(int(size*.08),int(size*.4)))
expected=expected[region];actual=n[region];active=np.abs(expected[:,:,1])>.03
error=float(np.abs(actual[:,:,1][active]-expected[:,:,1][active]).mean())
inverted=float(np.abs(actual[:,:,1][active]+expected[:,:,1][active]).mean())
assert active.sum()>100 and error<.02 and error<inverted*.1
report['openGlYPlus']={'samples':int(active.sum()),'meanGreenError':error,'invertedGreenError':inverted,'verified':True}

(root/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
