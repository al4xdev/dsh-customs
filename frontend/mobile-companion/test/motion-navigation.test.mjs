import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../src/motion/navigation.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser' });
const navigation = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const physicsBundle = await build({ entryPoints: [new URL('../src/motion/physics.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser' });
const physics = await import(`data:text/javascript;base64,${Buffer.from(physicsBundle.outputFiles[0].text).toString('base64')}`);
const { lockAxis, edgeDirection, directedDistance, resistedDistance, shouldCommit, settleDuration } = physics;

class Classes {
  values = new Set();
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}
class Element extends EventTarget {
  nodeType = 1; parentElement = null; scrollWidth = 393; clientWidth = 393;
  classList = new Classes(); properties = new Map(); attributes = new Map(); animations = [];
  style = { setProperty: (name,value)=>this.properties.set(name,value), getPropertyValue:name=>this.properties.get(name)??'', removeProperty:name=>this.properties.delete(name) };
  closest() { return this.excluded ? this : null; }
  contains(node) { while(node) { if(node===this) return true; node=node.parentElement; } return false; }
  getBoundingClientRect() { return {left:0,width:393}; }
  setAttribute(name,value) { this.attributes.set(name,value); }
  removeAttribute(name) { this.attributes.delete(name); }
  animate(frames,options) {
    const animation={frames,options,cancelled:0,finished:Promise.resolve(),cancel(){this.cancelled++;}};
    this.animations.push(animation); return animation;
  }
}
function environment({reduced=false}={}) {
  const media = new EventTarget(); media.matches = reduced;
  const frames = new Map(); let serial=0; let selection='';
  const view={Element,HTMLElement:Element,Node:Element,matchMedia:()=>media,requestAnimationFrame:callback=>{frames.set(++serial,callback);return serial;},cancelAnimationFrame:id=>frames.delete(id)};
  const root=new Element(),surface=new Element(),target=new Element();
  surface.parentElement=root;target.parentElement=surface;
  root.ownerDocument={defaultView:view,getSelection:()=>({toString:()=>selection})};
  root.querySelector=()=>surface;root.querySelectorAll=()=>[surface];
  let back=0,forward=0,canForward=true,selected='companion-owned';
  const controller=navigation.attachNavigationMotion({root,getSelectedId:()=>selected,back:()=>{back++;selected=undefined;},forward:()=>{forward++;selected='companion-owned';},canForward:()=>canForward});
  function touch(type,x,y,time,targetNode=target) {
    const touch={identifier:7,clientX:x,clientY:y};
    const event=new Event(type,{cancelable:true});
    Object.defineProperty(event,'timeStamp',{value:time});
    Object.defineProperty(event,'target',{value:targetNode});
    const touches=type==='touchend'?[]:[touch];
    Object.assign(touches,{item:index=>touches[index]??null});
    Object.assign(event,{touches,changedTouches:[touch]});
    root.dispatchEvent(event);return event;
  }
  return {root,surface,target,controller,frames,media,touch,get back(){return back;},get forward(){return forward;},set selected(value){selected=value;},set canForward(value){canForward=value;},set selection(value){selection=value;},flush(){for(const callback of frames.values())callback();frames.clear();}};
}
const settled=()=>new Promise(resolve=>{setImmediate(resolve);});

test('axis lock leaves diagonal jitter and vertical scrolling alone',()=>{
 assert.equal(lockAxis(4,4),'pending');assert.equal(lockAxis(15,15),'pending');
 assert.equal(lockAxis(26,5),'horizontal');assert.equal(lockAxis(5,26),'vertical');
});
test('only valid edge/direction with a known forward route is eligible',()=>{
 assert.equal(edgeDirection(14,393,true,false),'back');assert.equal(edgeDirection(190,393,true,true),undefined);
 assert.equal(edgeDirection(380,393,false,true),'forward');assert.equal(edgeDirection(380,393,false,false),undefined);
 assert.equal(edgeDirection(0,0,true,true),undefined);assert.equal(directedDistance(-40,'back'),0);assert.equal(directedDistance(-40,'forward'),40);
});
test('distance resistance and commit thresholds reject accidental short taps',()=>{
 assert.equal(resistedDistance(40,393),40);assert.ok(resistedDistance(450,393)<450);
 assert.equal(resistedDistance(10000,393),393);assert.equal(resistedDistance(NaN,393),0);
 assert.equal(shouldCommit(20,2,393),false);assert.equal(shouldCommit(40,.7,393),true);
 assert.equal(shouldCommit(115,0,393),true);assert.equal(shouldCommit(80,0,393),false);
 assert.equal(shouldCommit(120,NaN,393),false);
 assert.ok(settleDuration(100,.3,393)>=160);assert.ok(settleDuration(100,.3,393)<=300);
});
test('controls, horizontal scrollers and text selection retain their native gestures',()=>{
 const env=environment();env.target.excluded=true;
 assert.equal(navigation.isGestureExcluded(env.target,env.root),true);
 env.target.excluded=false;env.target.scrollWidth=600;
 assert.equal(navigation.isGestureExcluded(env.target,env.root),true);
 env.target.scrollWidth=393;assert.equal(navigation.isGestureExcluded(env.target,env.root,true),true);
 assert.equal(navigation.isGestureExcluded(env.target,env.root),false);
 env.controller.dispose();
});
test('back follows one surface in RAF, commits once, and restores inline state',async()=>{
 const env=environment();env.surface.style.setProperty('--motion-nav-x','2px');
 env.touch('touchstart',12,180,0);const move=env.touch('touchmove',150,184,200);
 assert.equal(move.defaultPrevented,true);assert.equal(env.frames.size,1);env.flush();
 assert.equal(env.surface.style.getPropertyValue('--motion-nav-x'),'138.00px');
 env.touch('touchend',150,184,210);await settled();assert.equal(env.back,1);
 assert.equal(env.surface.style.getPropertyValue('--motion-nav-x'),'2px');
 assert.equal(env.surface.classList.contains('is-nav-gesturing'),false);env.controller.dispose();
});
test('vertical gesture and wrong-direction edge drag never suppress native scrolling',async()=>{
 const env=environment();env.touch('touchstart',12,180,0);
 assert.equal(env.touch('touchmove',15,230,40).defaultPrevented,false);
 env.touch('touchend',15,230,50);await settled();assert.equal(env.back,0);
 env.touch('touchstart',20,180,100);assert.equal(env.touch('touchmove',2,181,120).defaultPrevented,false);
 env.controller.dispose();
});
test('short drag springs back; stale flick velocity after a pause does not commit',async()=>{
 const env=environment();env.touch('touchstart',12,180,0);env.touch('touchmove',58,181,20);
 env.touch('touchend',58,181,200);await settled();assert.equal(env.back,0);
 assert.equal(env.surface.animations[0].frames[1].transform,'translate3d(0px,0,0)');env.controller.dispose();
});
test('forward is rechecked at commit; revoked route never executes',async()=>{
 const env=environment();env.selected=undefined;env.touch('touchstart',380,180,0);
 env.touch('touchmove',230,181,200);env.canForward=false;env.touch('touchend',230,181,210);
 await settled();assert.equal(env.forward,0);env.controller.dispose();
});
test('reduced motion keeps gesture navigation without moving frames',async()=>{
 const env=environment({reduced:true});env.touch('touchstart',12,180,0);env.touch('touchmove',150,184,200);
 assert.equal(env.frames.size,0);env.touch('touchend',150,184,210);await settled();
 assert.equal(env.back,1);assert.equal(env.surface.animations.length,0);env.controller.enter('back');
 assert.equal(env.surface.animations.length,0);env.controller.dispose();
});
test('dispose cancels pending frames/animations and removes all active handlers',async()=>{
 const env=environment();env.touch('touchstart',12,180,0);env.touch('touchmove',80,181,40);
 assert.equal(env.frames.size,1);env.controller.dispose();assert.equal(env.frames.size,0);
 env.touch('touchend',150,181,50);await settled();assert.equal(env.back,0);
 assert.equal(env.root.classList.contains('mobile-motion-root'),false);
 assert.equal(env.surface.classList.contains('is-nav-gesturing'),false);
 assert.equal(await env.controller.navigate('back',()=>assert.fail()),false);
 env.controller.dispose();
});
test('event targets must be elements from the owned document realm',()=>{
  const env=environment();
  assert.equal(navigation.isGestureExcluded(null,env.root),true);
  assert.equal(navigation.isGestureExcluded(new EventTarget(),env.root),true);
  const outside=new Element();
  assert.equal(navigation.isGestureExcluded(outside,env.root),true);
  const textLike=new EventTarget();Object.assign(textLike,{nodeType:3,parentElement:env.surface});
  assert.equal(navigation.isGestureExcluded(textLike,env.root),true);
  const foreign=new(class extends EventTarget {})();Object.assign(foreign,{nodeType:1,parentElement:env.surface});
  assert.equal(navigation.isGestureExcluded(foreign,env.root),true);
  env.controller.dispose();
});
test('missing touch slot cannot start navigation or schedule a frame',async()=>{
  const env=environment();
  const event=new Event('touchstart',{cancelable:true});
  Object.defineProperty(event,'target',{value:env.target});
  Object.assign(event,{touches:{length:1,item:()=>null},changedTouches:[]});
  env.root.dispatchEvent(event);
  env.touch('touchmove',200,181,25);env.touch('touchend',200,181,35);await settled();
  assert.equal(env.frames.size,0);assert.equal(env.back,0);
  env.controller.dispose();
});
test('detached documents decline motion without registering a live root',async()=>{
  const root=new Element();root.ownerDocument={defaultView:null};
  const controller=navigation.attachNavigationMotion({root,getSelectedId:()=>undefined,back:()=>assert.fail(),forward:()=>assert.fail()});
  assert.equal(await controller.navigate('back',()=>assert.fail()),false);
  controller.enter('forward');controller.dispose();controller.dispose();
  assert.equal(root.classList.contains('mobile-motion-root'),false);
});
test('disposal during a pending outgoing animation never invokes navigation',async()=>{
  const env=environment();let finish;let calls=0;
  const finished=new Promise(resolve=>{finish=resolve;});
  env.surface.animate=(frames,options)=>{
    const animation={frames,options,finished,cancelled:0,cancel(){this.cancelled++;finish();}};
    env.surface.animations.push(animation);return animation;
  };
  const pending=env.controller.navigate('back',()=>{calls++;});
  env.controller.dispose();
  assert.equal(await pending,false);assert.equal(calls,0);
  assert.ok(env.surface.animations[0].cancelled>=1);
});
test('programmatic transition invokes admission only after outgoing presentation and errors stay contained',async()=>{
 const env=environment();let admitted=0;
 assert.equal(await env.controller.navigate('forward',()=>{admitted++;}),true);
 assert.equal(admitted,1);env.controller.enter('forward');await settled();
 assert.equal(env.surface.animations.length,2);
 assert.equal(await env.controller.navigate('back',()=>{throw Error('synthetic');}),false);
 env.controller.dispose();
});
