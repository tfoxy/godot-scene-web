import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ticker } from "pixi.js";

const { renderSpy, resizeSpy, unloadSpy, appDestroySpy, controls } = vi.hoisted(() => ({ renderSpy: vi.fn(), resizeSpy: vi.fn(), unloadSpy: vi.fn(), appDestroySpy:vi.fn(), controls:{initError:null as Error|null,deferLoad:false,resolveLoad:null as null|((v:unknown)=>void),managedTextures:[] as unknown[],returnedTextures:[] as unknown[],boundsWidth:100,boundsHeight:50,webGLVersion:2,blendEnabled:true,scissorEnabled:true,stencilEnabled:true} }));
vi.mock("pixi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pixi.js")>();
  const TexturePool={returnTexture:vi.fn((texture:any)=>{texture.pooled=true;controls.returnedTextures.push(texture)})};
  let nextCacheTexture=0;
  class Container { children:any[]=[]; parent:any=null; mask:any=null; filters:any=null; alpha=1; tint=0xffffff; blendMode="normal"; sortableChildren=false; destroyed=false; scale={set:vi.fn()}; renderGroup:any=null; onViewUpdate(){} once(){} cacheAsTexture=vi.fn((x:any)=>{
      if(!x){if(this.renderGroup?.texture)TexturePool.returnTexture(this.renderGroup.texture);this.renderGroup=null;return}
      if(this.renderGroup?.texture)TexturePool.returnTexture(this.renderGroup.texture);
      this.renderGroup={...this.renderGroup,isCachedAsTexture:true,texture:{id:++nextCacheTexture,pooled:false},textureNeedsUpdate:false,
        textureOptions:x,structureDidChange:true,invalidateMatrices:vi.fn(),renderGroupParent:null};
    }); updateCacheTexture=vi.fn();
    addChildAt(c:any,i:number){ if(c.parent){const p=c.parent.children.indexOf(c);if(p>=0)c.parent.children.splice(p,1);} c.parent=this;this.children.splice(i,0,c);return c; }
    addChild(c:any){return this.addChildAt(c,this.children.length)} getChildAt(i:number){return this.children[i]} getChildIndex(c:any){return this.children.indexOf(c)} getLocalBounds(){return {width:controls.boundsWidth,height:controls.boundsHeight}} removeChild(c:any){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);c.parent=null;return c} removeChildren(){const x=this.children.splice(0);for(const c of x)c.parent=null;return x}
    get localTransform(){return (this as any).matrix ?? new Matrix(1,0,0,1,0,0)}
    setFromMatrix(m:any){(this as any).matrix=m} destroy(options?:any){
      if(options?.children)for(const child of [...this.children])child.destroy({children:true});
      if(this.renderGroup?.texture)TexturePool.returnTexture(this.renderGroup.texture);
      this.destroyed=true;if(this.parent){const i=this.parent.children.indexOf(this);if(i>=0)this.parent.children.splice(i,1);} this.parent=null;
    }
  }
  class CanvasSource {resource:any;width:number;height:number;updates=0;destroyed=false;constructor(o:any){this.resource=o.resource;this.width=o.resource.width;this.height=o.resource.height}update(){this.updates++}destroy(){this.destroyed=true}}
  class Texture { static WHITE=new Texture({source:{width:1,height:1}}); source:any; frame:any; destroyed=false;destroySource=false;constructor(o:any={}){this.source=o.source??{width:64,height:32};this.frame=o.frame;} destroy(source=false){this.destroyed=true;this.destroySource=source;if(source)this.source.destroy?.()} }
  class Sprite extends Container { texture:any=Texture.WHITE; }
  class NineSliceSprite extends Sprite {leftWidth=0;rightWidth=0;topHeight=0;bottomHeight=0;width=0;height=0;constructor(o:any){super();this.texture=o.texture}}
  class Graphics extends Container {fills:any[]=[];rects:any[][]=[];clear(){return this} rect(...args:any[]){this.rects.push(args);return this} roundRect(){return this} fill(color?:any){this.fills.push(color);return this} moveTo(){return this} lineTo(){return this} stroke(){return this}}
  class Text extends Container {text="";style:any;constructor(o:any){super();this.text=o.text;this.style=o.style}}
  class RenderContainer extends Container {renderPipeId="customRender";isRenderable=true;groupTransform={a:1,b:0,c:0,d:1,tx:0,ty:0};groupColorAlpha=0xffffffff;render:any;addBounds:any;constructor(o:any){super();this.render=o.render;this.addBounds=o.addBounds}}
  class TextStyle {constructor(o:any){Object.assign(this,o)}}
  const CanvasTextMetrics={clearMetrics:vi.fn()};
  class MeshGeometry {positions:any;uvs:any;indices:any;constructor(_:any){}}
  class Mesh extends Container {geometry:any;texture:any;constructor(o:any){super();Object.assign(this,o)}}
  class Matrix {a:number;b:number;c:number;d:number;tx:number;ty:number;constructor(...args:any[]){(this as any).args=args;[this.a,this.b,this.c,this.d,this.tx,this.ty]=args.length?args:[1,0,0,1,0,0]}clone(){return new Matrix(...(this as any).args)}}
  class Rectangle {constructor(public x:number,public y:number,public width:number,public height:number){}}
  class ColorMatrixFilter {matrix:any}
  class Application {stage=new Container(); renderer:any={render:renderSpy,resize:resizeSpy,resolution:1,events:{setTargetElement:vi.fn()},resetState:vi.fn(),context:{get webGLVersion(){return controls.webGLVersion}},gl:{BLEND:1,SCISSOR_TEST:2,STENCIL_TEST:3,SCISSOR_BOX:4,isEnabled:vi.fn((flag:number)=>flag===1?controls.blendEnabled:flag===2?controls.scissorEnabled:controls.stencilEnabled),enable:vi.fn(),disable:vi.fn(),scissor:vi.fn(),getParameter:vi.fn(()=>new Int32Array([3,4,20,30]))},globalUniforms:{globalUniformData:{projectionMatrix:new Matrix(.02,0,0,-.04,-1,1),worldTransformMatrix:new Matrix(),worldColor:0xffffffff,offset:{x:0,y:0}}},renderTarget:{viewport:new Rectangle(0,0,100,50),renderTarget:{id:1}},shader:{resetState:vi.fn()},geometry:{resetState:vi.fn()},buffer:{resetState:vi.fn()},texture:{resetState:vi.fn(),get managedTextures(){return controls.managedTextures}},state:{stateId:1,blendMode:"normal",_blendEq:false,setBlend:vi.fn((enabled:boolean)=>{controls.blendEnabled=enabled}),setBlendMode:vi.fn(function(this:any,mode:string){this.blendMode=mode})},stencil:{resetState:vi.fn()},canvasText:{getTexture:vi.fn()}}; async init(){if(controls.initError)throw controls.initError} stop(){} destroy(){appDestroySpy()} }
  const Assets={load:vi.fn(()=>controls.deferLoad?new Promise((resolve)=>{controls.resolveLoad=resolve}):Promise.resolve(new Texture({source:{width:64,height:32}}))),unload:unloadSpy};
  return {...actual,Application,Assets,CanvasSource,CanvasTextMetrics,Container,Graphics,Matrix,Mesh,MeshGeometry,NineSliceSprite,Rectangle,RenderContainer,Sprite,Text,TextStyle,Texture,TexturePool,ColorMatrixFilter,extensions:{add:vi.fn()}};
});

import { BLEND_ADD, BLEND_MIX, DRAW_QUAD, createClipRectView, createDrawList, createGlyphsView, createPolylineView, createQuadView, createTexturedMeshView } from "../src/draw-list";
import { createPixiDrawListRenderer, type PixiTextRecord } from "../src/pixi-renderer";

function quad(){const q=createQuadView();q.m.set([1,0,0,1,0,0]);q.w=64;q.h=32;q.srcW=64;q.srcH=32;q.r=q.g=q.b=q.a=1;q.blend=BLEND_MIX;return q}

function carrier(key="label", alpha=1): PixiTextRecord {
  return {key,labelId:key,insertionIndex:0,text:"Glyph",transform:[1,0,0,1,0,0],style:{fontSize:12},
    alpha,tint:0xffffff,nativeFallback:[{key:`${key}:native`,labelId:key,insertionIndex:0,text:"Glyph",
      transform:[1,0,0,1,0,0],style:{fontSize:12},alpha:1,tint:0xffffff}],
    glyph:{contentKey:"face:v1",cacheEligible:true,box:{width:20,height:10},
      inkBounds:{x:-3,y:-2,width:26,height:14},block:{runCount:1,origins:Float32Array.of(2,4),
        spans:Int32Array.of(0,1),colors:Float32Array.of(.8,.4,.2,.5),spreads:Float32Array.of(1),
        slots:Int32Array.of(7),positions:Float32Array.of(1,2),pixelsPerEm:12,blockScale:2}}};
}

function glyphProvider(drawRun=(view:any)=>({glyphs:view.glyphCount,drawCalls:1})) {
  return {pass:{drawRun},invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()};
}

describe("Pixi draw-list adapter",()=>{
  beforeEach(()=>{renderSpy.mockClear();resizeSpy.mockClear();unloadSpy.mockClear();appDestroySpy.mockClear();controls.initError=null;controls.deferLoad=false;controls.resolveLoad=null;controls.managedTextures=[];controls.returnedTextures=[];controls.boundsWidth=100;controls.boundsHeight=50;controls.webGLVersion=2;controls.blendEnabled=controls.scissorEnabled=controls.stencilEnabled=true});
  it("counts live native GPU textures separately from registry tombstones",async()=>{
    controls.managedTextures=[{uid:1},null,{uid:2},null];
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,textureUrl:(x:string)=>x});
    expect(r.render(createDrawList<string>())).toBe(true);
    expect(r.stats.gpuTextures).toBe(2);expect(r.stats.gpuTextureSlots).toBe(4);r.dispose();
  });
  it("detaches only its own event target across repeated lifecycles", async () => {
    const unrelated=vi.fn();Ticker.system.add(unrelated);
    try {
      for(let i=0;i<3;i++) {
        const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,textureUrl:(x:string)=>x});
        expect((r.app.renderer.events as any).setTargetElement).toHaveBeenCalledWith(null);
        r.dispose();
      }
      Ticker.system.update(performance.now()+1000);
      expect(unrelated).toHaveBeenCalled();
      expect(appDestroySpy).toHaveBeenCalledTimes(3);
    } finally { Ticker.system.remove(unrelated); }
  });
  it("initializes, coalesces texture readiness, retains identical objects and disposes ownership",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x,identityAt:()=>"node:quad"});
    const l=createDrawList<string>();l.pushQuad(quad(),"/img");
    expect(r.render(l)).toBe(false);await vi.waitFor(()=>expect(r.stats.resourcePending).toBe(0));expect(r.render(l)).toBe(true);
    const created=r.stats.created;expect(r.render(l)).toBe(true);expect(r.stats.created).toBe(created);expect(r.stats.updated).toBe(0);
    r.resize(200,100);expect(resizeSpy).toHaveBeenCalled();r.dispose();expect(unloadSpy).toHaveBeenCalled();
  });
  it("updates owned pixel textures, invalidates their crops, and destroys them without Assets unload",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const source=document.createElement("canvas");source.width=64;source.height=32;
    r.bindPixelTexture("client://chrome",source,1);
    const l=createDrawList<string>();l.pushQuad(quad(),"client://chrome");
    expect(r.render(l)).toBe(true);expect(r.stats.frameTextures).toBe(1);expect(r.stats.textureLoads).toBe(0);
    const first=(r.app as any).stage.children[0].texture;
    r.bindPixelTexture("client://chrome",source,2);
    expect(first.destroyed).toBe(true);expect(r.stats.frameTextures).toBe(1);
    expect(r.render(l)).toBe(true);const second=(r.app as any).stage.children[0].texture;expect(second).not.toBe(first);
    const pixelSource=second.source;r.dispose();expect(pixelSource.destroyed).toBe(true);
    expect(unloadSpy).not.toHaveBeenCalledWith(expect.arrayContaining(["client://chrome"]));
  });
  it("preserves nested clip order and supports line and mesh primitives",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>(),c=createClipRectView();c.w=c.h=50;c.cornerRadius=8;l.pushClipRect(c);const inner=createClipRectView();inner.x=5;inner.y=5;inner.w=inner.h=20;l.pushClipRect(inner);
    const line=createPolylineView(2);line.points.set([0,0,10,10]);line.pointCount=2;line.width=2;line.r=line.g=line.b=line.a=1;l.pushPolyline(line);
    const mesh=createTexturedMeshView(3,3);mesh.m.set([1,0,0,1,4,5]);mesh.positions.set([0,0,10,0,0,10]);mesh.uvs.set([0,0,1,0,0,1]);mesh.indices.set([0,1,2]);mesh.vertexCount=3;mesh.indexCount=3;mesh.a=mesh.r=mesh.g=mesh.b=1;l.pushTexturedMesh(mesh,"/mesh");l.popClip();l.popClip();
    expect(r.render(l)).toBe(false);await vi.waitFor(()=>expect(r.stats.resourcePending).toBe(0));expect(r.render(l)).toBe(true);expect(r.stats.objects).toBeGreaterThanOrEqual(6);
    const root=(r.app as any).stage, outer=root.children.find((x:any)=>x.mask), nested=outer.children.find((x:any)=>x.mask), meshDisplay=nested.children.find((x:any)=>x.geometry);
    expect(outer.mask.parent).toBe(root);expect(nested.mask.parent).toBe(outer);expect(Array.from(meshDisplay.geometry.positions)).toEqual([0,0,10,0,0,10]);expect(Array.from(meshDisplay.geometry.uvs)).toEqual([0,0,1,0,0,1]);expect(Array.from(meshDisplay.geometry.indices)).toEqual([0,1,2]);expect(meshDisplay.matrix.args.slice(4)).toEqual([4,5]);r.dispose();
  });
  it("refuses legacy glyph callbacks instead of admitting an incomplete frame",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,textureUrl:(x:string)=>x});
    const l=createDrawList<string>(),g=createGlyphsView(1);g.glyphCount=1;g.slots[0]=1;l.pushGlyphs(g,"font");
    expect(r.render(l)).toBe(false);expect(r.stats.refusedGlyphs).toBe(1);expect(renderSpy).not.toHaveBeenCalled();r.dispose();
  });
  it("omits clip GPU masks only under the attribution control while preserving scene submissions",async()=>{
    const l=createDrawList<string>(),c=createClipRectView();c.w=c.h=40;
    l.pushClipRect(c);l.pushQuad(quad());l.popClip();
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,diagnosticClipMode:"omit"});
    expect(r.admitScene(l,[],{primitives:[{id:"card",index:1}]}).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any;
    expect(root.children).toHaveLength(1);
    expect(root.children[0].mask).toBeNull();
    expect(root.children[0].children).toHaveLength(1);
    expect(r.stats.omittedClipMasksLastSubmission).toBe(1);
    expect(r.presentScene().presented).toBe(true);
    expect(r.stats.omittedClipMasksTotalSubmissions).toBe(2);
    r.dispose();
  });
  it("draws one initial frame then keeps retained updates moving without further GL submission",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,diagnosticSubmitMode:"skip-gl"});
    const l=createDrawList<string>();l.pushQuad(quad());
    expect(r.admitScene(l,[],{primitives:[{id:"moving",index:0}]}).presented).toBe(true);
    expect(renderSpy).toHaveBeenCalledOnce();
    expect(r.stats.completedFrames).toBe(1);
    expect(r.stats.presentationValid).toBe(true);
    expect(r.armDiagnosticSkipGl()).toBe(true);
    expect(r.patchScene({primitives:[{id:"moving",transform:[1,0,0,1,8,0]}]}).presented).toBe(true);
    expect(r.presentScene().presented).toBe(true);
    expect(renderSpy).toHaveBeenCalledOnce();
    expect(r.stats.skippedGlSubmissions).toBe(2);
    expect(r.stats.completedFrames).toBe(1);
    expect(r.stats.presentationValid).toBe(false);
    expect(r.stats.sceneAdmissions).toBe(1);
    expect(r.stats.scenePatches).toBe(1);
    r.dispose();
  });
  it("submits one changing full-canvas quad after an explicit resource-ready arm",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,diagnosticSubmitMode:"single-quad"});
    const l=createDrawList<string>();l.pushQuad(quad());
    expect(r.armDiagnosticSingleQuad()).toBe(false);
    expect(r.admitScene(l,[],{primitives:[{id:"moving",index:0}]}).presented).toBe(true);
    const realRoot=renderSpy.mock.lastCall?.[0] as any;
    expect(realRoot.children).toHaveLength(1);
    expect(r.stats.diagnosticQuadSubmissions).toBe(0);
    expect(r.armDiagnosticSingleQuad()).toBe(true);
    expect(r.patchScene({primitives:[{id:"moving",transform:[1,0,0,1,8,0]}]}).presented).toBe(true);
    const diagnosticRoot=renderSpy.mock.lastCall?.[0] as any;
    expect(diagnosticRoot).not.toBe(realRoot);
    expect(diagnosticRoot.children).toHaveLength(1);
    expect(diagnosticRoot.children[0].rects).toEqual([[0,0,100,50]]);
    expect(r.presentScene().presented).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(3);
    expect(renderSpy.mock.calls.slice(1).every(([root])=>root===diagnosticRoot)).toBe(true);
    expect(diagnosticRoot.children[0].fills).toEqual([0xe03060,0x30c0e0]);
    expect(r.stats.completedFrames).toBe(3);
    expect(r.stats.diagnosticQuadSubmissions).toBe(2);
    expect(r.stats.presentationValid).toBe(true);
    expect(r.stats.scenePatches).toBe(1);
    r.resize(200,100);
    expect(r.render(l)).toBe(true);
    expect(renderSpy.mock.lastCall?.[0]).not.toBe(diagnosticRoot);
    expect(r.armDiagnosticSingleQuad()).toBe(true);
    expect(r.render(l)).toBe(true);
    expect(diagnosticRoot.children[0].rects.at(-1)).toEqual([0,0,200,100]);
    r.dispose();
  });
  it("waits for scene textures before submitting the diagnostic quad",async()=>{
    controls.deferLoad=true;
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,diagnosticSubmitMode:"single-quad"});
    const l=createDrawList<string>();l.pushQuad(quad(),"/atlas");
    expect(r.render(l)).toBe(false);
    expect(renderSpy).not.toHaveBeenCalled();
    expect(r.stats.diagnosticQuadSubmissions).toBe(0);
    controls.resolveLoad?.(new (await import("pixi.js")).Texture({source:{width:64,height:32}}));
    await vi.waitFor(()=>expect(r.stats.resourcePending).toBe(0));
    expect(r.render(l)).toBe(true);
    expect(renderSpy).toHaveBeenCalledOnce();
    expect(r.stats.diagnosticQuadSubmissions).toBe(0);
    expect(r.armDiagnosticSingleQuad()).toBe(true);
    expect(r.render(l)).toBe(true);
    expect(r.stats.diagnosticQuadSubmissions).toBe(1);
    r.dispose();
  });
  it("redraws after resources arrive before arming the fixed-frame control",async()=>{
    controls.deferLoad=true;
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,diagnosticSubmitMode:"skip-gl"});
    expect(r.render(createDrawList<string>())).toBe(true);
    expect(r.stats.completedFrames).toBe(1);
    r.prefetch("/atlas");
    expect(r.stats.resourcePending).toBe(1);
    expect(r.armDiagnosticSkipGl()).toBe(false);
    controls.resolveLoad?.(new (await import("pixi.js")).Texture({source:{width:64,height:32}}));
    await vi.waitFor(()=>expect(r.stats.resourcePending).toBe(0));
    const l=createDrawList<string>();l.pushQuad(quad(),"/atlas");
    expect(r.render(l)).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(r.stats.completedFrames).toBe(2);
    expect(r.stats.presentationValid).toBe(true);
    expect(r.armDiagnosticSkipGl()).toBe(true);
    expect(r.render(l)).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(r.stats.skippedGlSubmissions).toBe(1);
    expect(r.stats.presentationValid).toBe(false);
    r.dispose();
  });
  it("never auto-arms skip GL before the caller requests it",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,
      textureUrl:(x:string)=>x,diagnosticSubmitMode:"skip-gl"});
    const l=createDrawList<string>();
    expect(r.armDiagnosticSkipGl()).toBe(false);
    expect(r.render(l)).toBe(true);
    expect(r.render(l)).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(r.stats.skippedGlSubmissions).toBe(0);
    expect(r.armDiagnosticSkipGl()).toBe(true);
    expect(r.render(l)).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(r.stats.skippedGlSubmissions).toBe(1);
    r.dispose();
  });
  it("refuses external draw callbacks without invoking them",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,textureUrl:(x:string)=>x});
    const execute=vi.fn(()=>true),l=createDrawList<string>();l.pushExternalEffect({execute});
    expect(r.render(l)).toBe(false);expect(r.stats.refusedEffects).toBe(1);expect(execute).not.toHaveBeenCalled();r.dispose();
  });
  it("updates retained native text only when content or style changes",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,textureUrl:(x:string)=>x});
    const l=createDrawList<string>(), base={key:"label",insertionIndex:0,text:"A",transform:[1,0,0,1,2,3],style:{fontSize:12}};
    expect(r.render(l,[base])).toBe(true);expect(r.stats.textInvalidations).toBe(1);
    expect(r.render(l,[base])).toBe(true);expect(r.stats.textInvalidations).toBe(1);
    expect(r.render(l,[{...base,text:"B"}])).toBe(true);expect(r.stats.textInvalidations).toBe(2);
    expect(r.render(l,[{...base,text:"B",style:{fontSize:18}}])).toBe(true);expect(r.stats.textInvalidations).toBe(3);
    expect(r.stats.created).toBe(1);expect(r.stats.updated).toBe(2);r.dispose();
  });
  it("patches only named primitives for more than 120 absolute animation poses",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>();l.pushQuad(quad());l.pushQuad(quad());
    const plan={primitives:[{id:"moving",index:0},{id:"still",index:1}]};
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any;
    const moving=root.children[0],still=root.children[1];
    const unchangedMatrix=still.matrix;
    const kindAt=vi.spyOn(l,"kindAt");
    for(let step=0;step<130;step++) expect(r.patchScene({primitives:[{id:"moving",transform:[1,0,0,1,step,4]}]}).presented).toBe(true);
    expect(moving.matrix.args.slice(4)).toEqual([129,4]);
    expect(still.matrix).toBe(unchangedMatrix);
    expect(kindAt).not.toHaveBeenCalled();
    expect(r.stats.sceneAdmissions).toBe(1);expect(r.stats.scenePatches).toBe(130);
    expect(r.stats.sceneChangedObjects).toBe(130);
    r.dispose();
  });
  it("preflights a complete patch and rolls back on failed presentation",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>();l.pushQuad(quad());
    expect(r.admitScene(l,[],{primitives:[{id:"a",index:0}]}).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any, sprite=root.children[0];
    expect(r.patchScene({primitives:[{id:"a",transform:[1,0,0,1,10,0]},{id:"missing",alpha:0}]}).presented).toBe(false);
    expect(sprite.matrix.args.slice(4)).toEqual([0,0]);
    renderSpy.mockImplementationOnce(()=>{throw new Error("lost context")});
    expect(r.patchScene({primitives:[{id:"a",transform:[1,0,0,1,20,0]}]})).toEqual({presented:false,reason:"lost context"});
    expect(sprite.matrix.args.slice(4)).toEqual([0,0]);
    expect(r.presentScene().presented).toBe(true);
    r.dispose();
  });
  it("keeps group children stable during parent motion and retires old crops after a source swap",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const source=document.createElement("canvas");source.width=128;source.height=32;
    r.bindPixelTexture("atlas",source,1);
    const l=createDrawList<string>();l.pushQuad(quad(),"atlas");
    const plan={primitives:[{id:"sprite",index:0,parentId:"actor"}],groups:[{id:"actor",firstIndex:0,endIndex:1,transform:[1,0,0,1,0,0],renderGroup:true}]};
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any,group=root.children[0],sprite=group.children[0];
    const oldFrame=sprite.texture,oldChildMatrix=sprite.matrix;
    expect(r.patchScene({groups:[{id:"actor",transform:[1,0,0,1,12,8]}]}).presented).toBe(true);
    expect(group.matrix.args.slice(4)).toEqual([12,8]);expect(sprite.matrix).toBe(oldChildMatrix);
    expect(r.patchScene({primitives:[{id:"sprite",source:{texture:"atlas",x:64,y:0,w:64,h:32}}]}).presented).toBe(true);
    expect(sprite.texture).not.toBe(oldFrame);expect(oldFrame.destroyed).toBe(true);
    expect(r.stats.frameTextures).toBe(1);
    r.dispose();
  });
  it("ignores equal retained fields while still presenting an empty effective patch",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const source=document.createElement("canvas");source.width=128;source.height=32;
    r.bindPixelTexture("atlas",source,1);
    const l=createDrawList<string>();l.pushQuad(quad(),"atlas");
    expect(r.admitScene(l,[],{primitives:[{id:"sprite",index:0}]}).presented).toBe(true);
    const sprite=(renderSpy.mock.lastCall?.[0] as any).children[0], matrix=sprite.matrix, texture=sprite.texture;
    const before=r.stats.sceneChangedObjects, frames=r.stats.completedFrames;
    const same={texture:"atlas",x:0,y:0,w:64,h:32};
    expect(r.patchScene({primitives:[{id:"sprite",source:same,transform:[1,0,0,1,0,0],alpha:1,tint:0xffffff}]}).presented).toBe(true);
    expect(sprite.matrix).toBe(matrix);expect(sprite.texture).toBe(texture);
    expect(r.stats.sceneChangedObjects).toBe(before);
    expect(r.stats.completedFrames).toBe(frames+1);
    expect(r.patchScene({primitives:[{id:"sprite",source:same},{id:"sprite",source:same}]}).presented).toBe(false);
    r.dispose();
  });
  it("reuses unchanged native Text through a structural admission and restores it on failed admission",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>();l.pushQuad(quad());
    const text={key:"label",insertionIndex:0,text:"Stable",transform:[1,0,0,1,5,6],style:{fontSize:12}};
    expect(r.admitScene(l,[text],{primitives:[{id:"a",index:0}]}).presented).toBe(true);
    const firstRoot=renderSpy.mock.lastCall?.[0] as any, firstText=firstRoot.children[0];
    expect(r.admitScene(l,[text],{primitives:[{id:"a",index:0}]}).presented).toBe(true);
    const secondRoot=renderSpy.mock.lastCall?.[0] as any;
    expect(secondRoot.children[0]).toBe(firstText);expect(r.stats.textInvalidations).toBe(1);
    renderSpy.mockImplementationOnce(()=>{throw new Error("draw failed")});
    expect(r.admitScene(l,[{...text,transform:[1,0,0,1,50,60]}],{primitives:[{id:"a",index:0}]}).presented).toBe(false);
    expect(firstText.parent).toBe(secondRoot);expect(firstText.matrix.args.slice(4)).toEqual([5,6]);
    expect(r.presentScene().presented).toBe(true);
    r.dispose();
  });
  it("invalidates native Text pixels when its font resource revision changes",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>(),plan={primitives:[]};
    const record={key:"label",insertionIndex:0,text:"Same",transform:[1,0,0,1,0,0],style:{fontFamily:"Demo"},resourceRevision:"font:v1"};
    expect(r.admitScene(l,[record],plan).presented).toBe(true);
    const first=(renderSpy.mock.lastCall?.[0] as any).children[0];
    expect(r.admitScene(l,[{...record,resourceRevision:"font:v2"}],plan).presented).toBe(true);
    const second=(renderSpy.mock.lastCall?.[0] as any).children[0];
    expect(second).not.toBe(first);
    expect(r.stats.textInvalidations).toBe(2);
    r.dispose();
  });
  it("projects selective static caches at current backing scale after resize",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,designWidth:100,designHeight:50,resolution:2,textureUrl:(x:string)=>x});
    r.resize(200,100,2,100,50);
    const l=createDrawList<string>();l.pushQuad(quad());l.pushQuad(quad());
    const plan={primitives:[{id:"a",index:0,parentId:"static"},{id:"b",index:1,parentId:"static"}],groups:[{id:"static",firstIndex:0,endIndex:2,transform:[1,0,0,1,0,0],cacheAsTexture:true}]};
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any,group=root.children[0];
    expect(root.scale.set).toHaveBeenCalledWith(2,2);
    expect(group.cacheAsTexture).toHaveBeenCalledWith({resolution:4});
    expect(r.patchScene({primitives:[{id:"a",alpha:0.5}]}).presented).toBe(true);
    expect(group.renderGroup?.isCachedAsTexture).toBe(false);
    expect(r.presentScene().presented).toBe(true);
    expect(group.renderGroup?.isCachedAsTexture).toBe(true);
    expect(r.patchScene({groups:[{id:"static",transform:[1,0,0,1,4,5]}]}).presented).toBe(true);
    const bakes=group.cacheAsTexture.mock.calls.length;
    expect(r.patchScene({groups:[{id:"static",transform:[2,0,0,2,4,5]}]}).presented).toBe(true);
    expect(group.renderGroup?.isCachedAsTexture).toBe(false);
    expect(group.cacheAsTexture).toHaveBeenCalledTimes(bakes);
    expect(r.presentScene().presented).toBe(true);
    expect(group.cacheAsTexture).toHaveBeenLastCalledWith({resolution:8});
    r.dispose();
  });
  it("keeps the last crop through failed source presentation and pixel-resource invalidation",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const source=document.createElement("canvas");source.width=128;source.height=32;
    const replacement=document.createElement("canvas");replacement.width=128;replacement.height=32;
    r.bindPixelTexture("atlas",source,1);
    const l=createDrawList<string>();l.pushQuad(quad(),"atlas");
    expect(r.admitScene(l,[],{primitives:[{id:"a",index:0}]}).presented).toBe(true);
    const sprite=(renderSpy.mock.lastCall?.[0] as any).children[0],oldFrame=sprite.texture;
    renderSpy.mockImplementationOnce(()=>{throw new Error("failed draw")});
    expect(r.patchScene({primitives:[{id:"a",source:{texture:"atlas",x:64,y:0,w:64,h:32}}]}).presented).toBe(false);
    expect(sprite.texture).toBe(oldFrame);expect(oldFrame.destroyed).toBe(false);
    r.bindPixelTexture("atlas",replacement,2);
    expect(oldFrame.destroyed).toBe(false);
    expect(oldFrame.source.resource).toBe(source);
    expect(r.presentScene().reason).toBe("retained scene unavailable");
    expect(r.admitScene(l,[],{primitives:[{id:"a",index:0}]}).presented).toBe(true);
    expect(oldFrame.destroyed).toBe(true);
    expect((renderSpy.mock.lastCall?.[0] as any).children[0].texture.source.resource).toBe(replacement);
    r.dispose();
  });
  it("reuses an unchanged crop across successful structural admissions",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const source=document.createElement("canvas");source.width=64;source.height=32;
    r.bindPixelTexture("atlas",source,1);
    const l=createDrawList<string>();l.pushQuad(quad(),"atlas");
    const plan={primitives:[{id:"a",index:0}]};
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    const first=(renderSpy.mock.lastCall?.[0] as any).children[0].texture;
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    expect((renderSpy.mock.lastCall?.[0] as any).children[0].texture).toBe(first);
    expect(first.destroyed).toBe(false);
    r.dispose();
  });
  it("invalidates retained publication across WebGL loss and restores through re-admission",async()=>{
    const canvas=document.createElement("canvas");
    const r=await createPixiDrawListRenderer({canvas,width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>();l.pushQuad(quad());
    const plan={primitives:[{id:"a",index:0}]};
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    const completed=r.stats.completedFrames;
    canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
    expect(r.patchScene({primitives:[{id:"a",alpha:0.4}]}).presented).toBe(false);
    expect(r.presentScene().presented).toBe(false);
    expect(r.stats.completedFrames).toBe(completed);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    expect(r.stats.completedFrames).toBe(completed+1);
    r.dispose();
  });
  it("defers excess static cache bakes and activates them on later presentations",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,textureUrl:(x:string)=>x});
    const l=createDrawList<string>(),primitives:any[]=[],groups:any[]=[];
    for(let i=0;i<5;i++){
      l.pushQuad(quad());l.pushQuad(quad());
      primitives.push({id:`a${i}`,index:i*2,parentId:`g${i}`},{id:`b${i}`,index:i*2+1,parentId:`g${i}`});
      groups.push({id:`g${i}`,firstIndex:i*2,endIndex:i*2+2,transform:[1,0,0,1,0,0],cacheAsTexture:true});
    }
    expect(r.admitScene(l,[],{primitives,groups}).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any;
    expect(root.children.filter((g:any)=>g.cacheAsTexture.mock.calls.length>0)).toHaveLength(4);
    expect(r.presentScene().presented).toBe(true);
    expect(root.children.filter((g:any)=>g.cacheAsTexture.mock.calls.length>0)).toHaveLength(5);
    r.dispose();
  });
  it("keeps an oversized cache group as retained children through scale changes",async()=>{
    controls.boundsWidth=600;controls.boundsHeight=600;
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,resolution:2,textureUrl:(x:string)=>x});
    const l=createDrawList<string>();l.pushQuad(quad());l.pushQuad(quad());
    const plan={primitives:[{id:"a",index:0,parentId:"g"},{id:"b",index:1,parentId:"g"}],groups:[{id:"g",firstIndex:0,endIndex:2,transform:[1,0,0,1,0,0],cacheAsTexture:true}]};
    expect(r.admitScene(l,[],plan).presented).toBe(true);
    const group=(renderSpy.mock.lastCall?.[0] as any).children[0];
    expect(group.cacheAsTexture).not.toHaveBeenCalled();
    expect(r.patchScene({groups:[{id:"g",transform:[0.5,0,0,0.5,0,0]}]}).presented).toBe(true);
    expect(r.presentScene().presented).toBe(true);
    expect(group.cacheAsTexture).toHaveBeenCalledWith({resolution:1});
    r.dispose();
  });
  it("refines a static cache after cumulative small scale changes cross the reuse band",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x});
    const list=createDrawList<string>();list.pushQuad(quad());list.pushQuad(quad());
    const plan={primitives:[{id:"a",index:0,parentId:"g"},{id:"b",index:1,parentId:"g"}],
      groups:[{id:"g",firstIndex:0,endIndex:2,transform:[1,0,0,1,0,0],cacheAsTexture:true}]};
    expect(r.admitScene(list,[],plan).presented).toBe(true);
    const group=(renderSpy.mock.lastCall?.[0] as any).children[0];
    let scale=1;
    for(let i=0;i<30 && group.renderGroup?.isCachedAsTexture;i++){
      scale*=1.01;
      expect(r.patchScene({groups:[{id:"g",transform:[scale,0,0,scale,0,0]}]}).presented).toBe(true);
    }
    expect(scale).toBeGreaterThan(1.25);
    expect(group.renderGroup?.isCachedAsTexture).toBe(false);
    expect(group.cacheAsTexture).toHaveBeenCalledTimes(1);
    expect(r.presentScene().presented).toBe(true);
    expect(group.cacheAsTexture.mock.lastCall?.[0].resolution).toBeCloseTo(scale);
    r.dispose();
  });
  it("moves a retained child out of a removed clip without destroying it",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:10,height:10,textureUrl:(x:string)=>x,identityAt:(_i,k)=>k===DRAW_QUAD?"moving":"clip"});
    const clipped=createDrawList<string>(),c=createClipRectView();c.w=c.h=10;clipped.pushClipRect(c);clipped.pushQuad(quad());clipped.popClip();expect(r.render(clipped)).toBe(true);
    const root=(r.app as any).stage, child=root.children.find((x:any)=>x.mask).children.find((x:any)=>"texture" in x);
    const plain=createDrawList<string>();plain.pushQuad(quad());expect(r.render(plain)).toBe(true);expect(child.parent).toBe(root);expect(child.destroyed).toBe(false);r.dispose();
  });
  it("destroys a partially initialized app and unloads a texture that resolves after disposal",async()=>{
    controls.initError=new Error("init");await expect(createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:1,height:1,textureUrl:(x:string)=>x})).rejects.toThrow("init");expect(appDestroySpy).toHaveBeenCalled();
    controls.initError=null;controls.deferLoad=true;const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:1,height:1,textureUrl:(x:string)=>x});const l=createDrawList<string>();l.pushQuad(quad(),"/late");expect(r.render(l)).toBe(false);r.dispose();
    controls.resolveLoad?.(new (await import("pixi.js")).Texture({source:{width:2,height:2}}));await vi.waitFor(()=>expect(unloadSpy).toHaveBeenCalledWith("/late"));
  });
  it("draws an owned glyph block through Pixi's target while preserving mask state",async()=>{
    const drawRun=vi.fn((view:any)=>({glyphs:view.glyphCount,drawCalls:1}));
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",createGlyphProvider:()=>({pass:{drawRun},invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()})});
    const list=createDrawList<string>();
    expect(r.admitScene(list,[carrier()],{primitives:[]}).presented).toBe(true);
    const outer=(renderSpy.mock.lastCall?.[0] as any).children[0],child=outer.children[0];
    expect(outer.children).toHaveLength(1);expect(r.textOutcomes()).toMatchObject({actual:"slug",slug:1,native:0});
    const renderer=(r.app as any).renderer, target=renderer.renderTarget.renderTarget;
    const broadResets=renderer.resetState.mock.calls.length;
    child.render(renderer);
    expect(drawRun).toHaveBeenCalledOnce();
    const view=drawRun.mock.calls[0][0];
    expect(Array.from(view.m)).toEqual([2,0,0,2,-6,3]);
    expect(view.a).toBeCloseTo(.5);expect(view.r).toBeCloseTo(.4);
    expect(renderer.renderTarget.renderTarget).toBe(target);
    expect(renderer.resetState).toHaveBeenCalledTimes(broadResets);
    expect(renderer.shader.resetState).toHaveBeenCalledOnce();
    expect(renderer.geometry.resetState).toHaveBeenCalledOnce();
    expect(renderer.stencil.resetState).not.toHaveBeenCalled();
    expect(renderer.gl.isEnabled).not.toHaveBeenCalled();
    expect(renderer.gl.getParameter).not.toHaveBeenCalled();
    expect(renderer.gl.scissor).not.toHaveBeenCalled();
    expect(renderer.buffer.resetState).not.toHaveBeenCalled();
    expect(renderer.state.blendMode).toBe("normal");
    expect(renderer.gl.disable).not.toHaveBeenCalledWith(renderer.gl.STENCIL_TEST);
    expect(controls.stencilEnabled).toBe(true);
    const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};child.addBounds(bounds);
    expect(bounds).toEqual({minX:-18,minY:-11,maxX:38,maxY:21});
    r.dispose();
  });
  it.each([true,false])("hands back Pixi blend and an existing scissor=%s without GL state reads",async(scissorEnabled)=>{
    controls.scissorEnabled=scissorEnabled;
    const drawRun=vi.fn((view:any)=>{controls.blendEnabled=true;return {glyphs:view.glyphCount,drawCalls:1}});
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",createGlyphProvider:()=>glyphProvider(drawRun)});
    expect(r.admitScene(createDrawList<string>(),[carrier()],{primitives:[]}).presented).toBe(true);
    const renderer=(r.app as any).renderer,child=(renderSpy.mock.lastCall?.[0] as any).children[0].children[0];
    const target={id:"offscreen"},viewport=new (await import("pixi.js")).Rectangle(7,11,43,29);
    renderer.renderTarget.renderTarget=target;renderer.renderTarget.viewport=viewport;
    renderer.state.stateId=0;renderer.state.blendMode="add";controls.blendEnabled=false;
    renderer.gl.isEnabled.mockClear();renderer.gl.getParameter.mockClear();renderer.gl.scissor.mockClear();
    child.render(renderer);
    expect(drawRun).toHaveBeenCalledOnce();
    expect(renderer.gl.isEnabled).not.toHaveBeenCalled();expect(renderer.gl.getParameter).not.toHaveBeenCalled();
    expect(renderer.gl.scissor).not.toHaveBeenCalled();
    expect(controls.scissorEnabled).toBe(scissorEnabled);expect(controls.blendEnabled).toBe(false);
    expect(renderer.state.setBlendMode).toHaveBeenLastCalledWith("add");
    expect(renderer.state.blendMode).toBe("add");expect(renderer.state.stateId).toBe(0);
    expect(renderer.renderTarget.renderTarget).toBe(target);expect(renderer.renderTarget.viewport).toBe(viewport);
    expect(renderer.stencil.resetState).not.toHaveBeenCalled();r.dispose();
  });
  it("restores tracked blend after a glyph pass throws without touching clipping or target",async()=>{
    const drawRun=vi.fn(()=>{controls.blendEnabled=true;throw new Error("glyph failure")});
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",createGlyphProvider:()=>glyphProvider(drawRun)});
    expect(r.admitScene(createDrawList<string>(),[carrier()],{primitives:[]}).presented).toBe(true);
    const renderer=(r.app as any).renderer,child=(renderSpy.mock.lastCall?.[0] as any).children[0].children[0];
    const target={id:"masked"};renderer.renderTarget.renderTarget=target;
    renderer.state.stateId=0;renderer.state.blendMode="multiply";controls.blendEnabled=false;
    expect(()=>child.render(renderer)).toThrow("glyph failure");
    expect(controls.blendEnabled).toBe(false);expect(renderer.state.blendMode).toBe("multiply");
    expect(renderer.renderTarget.renderTarget).toBe(target);
    expect(renderer.gl.isEnabled).not.toHaveBeenCalled();expect(renderer.gl.getParameter).not.toHaveBeenCalled();
    expect(renderer.gl.scissor).not.toHaveBeenCalled();expect(renderer.stencil.resetState).not.toHaveBeenCalled();
    r.dispose();
  });
  it.each(["add","multiply","min"])("restores real Pixi %s blend factors and equation after hb-gpu",async(mode)=>{
    const {GlStateSystem}=await vi.importActual<typeof import("pixi.js")>("pixi.js");
    const ONE=1,ONE_MINUS_SRC_ALPHA=2,DST_COLOR=3,FUNC_ADD=4,MIN=5,BLEND=6;
    let enabled=true,factors:number[]=[],equation:number[]=[];
    const gl={ONE,ONE_MINUS_SRC_ALPHA,DST_COLOR,FUNC_ADD,MIN,BLEND,
      enable:vi.fn(()=>{enabled=true}),disable:vi.fn(()=>{enabled=false}),
      blendFunc:vi.fn((...args:number[])=>{factors=args}),
      blendFuncSeparate:vi.fn((...args:number[])=>{factors=args}),
      blendEquation:vi.fn((value:number)=>{equation=[value,value]}),
      blendEquationSeparate:vi.fn((...args:number[])=>{equation=args})};
    const map={add:[ONE,ONE],multiply:[DST_COLOR,ONE_MINUS_SRC_ALPHA,ONE,ONE_MINUS_SRC_ALPHA],
      min:[ONE,ONE,ONE,ONE,MIN,MIN]};
    const state=Object.assign(Object.create(GlStateSystem.prototype),{
      gl,blendModesMap:map,stateId:1,blendMode:mode,_blendEq:mode==="min",checks:[]});
    const drawRun=vi.fn((view:any)=>{
      gl.enable(BLEND);gl.blendEquation(FUNC_ADD);gl.blendFunc(ONE,ONE_MINUS_SRC_ALPHA);
      return {glyphs:view.glyphCount,drawCalls:1};
    });
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",createGlyphProvider:()=>glyphProvider(drawRun)});
    expect(r.admitScene(createDrawList<string>(),[carrier()],{primitives:[]}).presented).toBe(true);
    const renderer=(r.app as any).renderer,child=(renderSpy.mock.lastCall?.[0] as any).children[0].children[0];
    renderer.state=state;
    child.render(renderer);
    expect(enabled).toBe(true);expect(factors).toEqual(map[mode as keyof typeof map].slice(0,mode==="add"?2:4));
    expect(equation).toEqual(mode==="min"?[MIN,MIN]:[FUNC_ADD,FUNC_ADD]);
    expect(state.stateId).toBe(1);expect(state.blendMode).toBe(mode);
    expect(renderer.gl.isEnabled).not.toHaveBeenCalled();expect(renderer.gl.getParameter).not.toHaveBeenCalled();
    r.dispose();
  });
  it("falls back per label on WebGL1 and patches common alpha/tint exactly once",async()=>{
    controls.webGLVersion=1;
    const makeProvider=vi.fn();
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",createGlyphProvider:makeProvider});
    const text={...carrier("label",.5),blend:BLEND_ADD},list=createDrawList<string>();
    expect(r.admitScene(list,[text],{primitives:[]}).presented).toBe(true);
    expect(makeProvider).not.toHaveBeenCalled();
    const outer=(renderSpy.mock.lastCall?.[0] as any).children[0];
    expect(outer.alpha).toBe(.5);expect(outer.children[0].alpha).toBe(1);
    expect(outer.blendMode).toBe("add");expect(outer.children[0].blendMode).toBe("inherit");
    expect(r.textOutcomes()).toMatchObject({actual:"native",native:1,reasons:{"WebGL2 unavailable":1}});
    expect(r.patchScene({primitives:[{id:"text:label",alpha:.7,tint:0x808080}]}).presented).toBe(true);
    expect(outer.alpha).toBe(.7);expect(outer.tint).toBe(0x808080);
    expect(outer.children[0].alpha).toBe(1);expect(outer.children[0].tint).toBe(0xffffff);
    renderSpy.mockImplementationOnce(()=>{throw new Error("draw failed")});
    expect(r.patchScene({primitives:[{id:"text:label",alpha:.2}]}).presented).toBe(false);
    expect(outer.alpha).toBe(.7);r.dispose();
  });
  it("counts multiple native paint fragments as one label",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"native"});
    const first={key:"line:0",labelId:"label",insertionIndex:0,text:"A",
      transform:[1,0,0,1,0,0],style:{fontSize:12}};
    const second={...first,key:"line:1",text:"B"};
    expect(r.admitScene(createDrawList<string>(),[first,second],{primitives:[]}).presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({requested:"native",actual:"native",native:1});
    r.dispose();
  });
  it("refines only pending label caches and keeps warm tint/scale patches cached",async()=>{
    const wakes:string[]=[];
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug-cached",onInvalidate:(reason)=>{if(reason)wakes.push(reason)},
      createGlyphProvider:()=>({pass:{drawRun:(view)=>({glyphs:view.glyphCount,drawCalls:1})},
        invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()})});
    const list=createDrawList<string>(),texts=Array.from({length:5},(_,i)=>carrier(`label${i}`));
    expect(r.admitScene(list,texts,{primitives:[]}).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any;
    expect(root.children.filter((x:any)=>x.children[0].renderGroup?.isCachedAsTexture)).toHaveLength(4);
    expect(r.textOutcomes()).toMatchObject({actual:"mixed",slugCached:4,slug:1});
    expect(wakes).toContain("present");
    expect(r.presentScene().presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({actual:"slug-cached",slugCached:5,slug:0});
    const cached=root.children[0].children[0],bakes=cached.cacheAsTexture.mock.calls.length;
    expect(r.patchScene({primitives:[{id:"text:label0",tint:0x8080ff}]}).presented).toBe(true);
    expect(cached.cacheAsTexture).toHaveBeenCalledTimes(bakes);
    expect(r.patchScene({primitives:[{id:"text:label0",transform:[1.1,0,0,1.1,0,0]}]}).presented).toBe(true);
    expect(cached.cacheAsTexture).toHaveBeenCalledTimes(bakes);
    expect(r.patchScene({primitives:[{id:"text:label0",alpha:.5}]}).presented).toBe(true);
    expect(cached.renderGroup?.isCachedAsTexture).toBe(false);expect(r.textOutcomes()).toMatchObject({slugCached:4,slug:1});
    expect(r.patchScene({primitives:[{id:"text:label0",alpha:1}]}).presented).toBe(true);
    expect(r.presentScene().presented).toBe(true);
    expect(cached.renderGroup?.isCachedAsTexture).toBe(true);
    expect(r.textOutcomes()).toMatchObject({slugCached:5,slug:0});
    r.dispose();
  });
  it("preserves committed glyph cache and outcomes after a failed structural admission",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug-cached",createGlyphProvider:()=>({pass:{drawRun:(view)=>({glyphs:view.glyphCount,drawCalls:1})},
        invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()})});
    const list=createDrawList<string>(),plan={primitives:[]};
    expect(r.admitScene(list,[carrier()],plan).presented).toBe(true);
    const root=renderSpy.mock.lastCall?.[0] as any,outer=root.children[0],child=outer.children[0];
    expect(child.renderGroup?.isCachedAsTexture).toBe(true);
    renderSpy.mockImplementationOnce(()=>{throw new Error("failed replacement")});
    expect(r.admitScene(list,[carrier("label",.5)],plan)).toEqual({presented:false,reason:"failed replacement"});
    expect(child.renderGroup?.isCachedAsTexture).toBe(true);expect(outer.parent).toBe(root);
    expect(r.textOutcomes()).toMatchObject({actual:"slug-cached",slugCached:1});
    expect(r.presentScene().presented).toBe(true);r.dispose();
  });
  it("rejects malformed blocks to native fallback and fails a dropped glyph frame",async()=>{
    const drawRun=vi.fn(()=>({glyphs:0,drawCalls:0}));
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",createGlyphProvider:()=>({pass:{drawRun},invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()})});
    const list=createDrawList<string>(),bad=carrier();
    bad.glyph!.block.positions[0]=NaN;
    expect(r.admitScene(list,[bad],{primitives:[]}).presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({native:1,reasons:{"invalid glyph block":1}});
    const good=carrier();
    renderSpy.mockImplementationOnce((root:any)=>root.children[0].children[0].render((r.app as any).renderer));
    expect(r.admitScene(list,[good],{primitives:[]})).toEqual({presented:false,reason:"glyph pass dropped retained glyphs"});
    expect(r.textOutcomes()).toMatchObject({native:1});
    r.dispose();
  });
  it("suspends both label and enclosing static cache for fractional group alpha",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug-cached",createGlyphProvider:()=>({pass:{drawRun:(view)=>({glyphs:view.glyphCount,drawCalls:1})},
        invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()})});
    const list=createDrawList<string>();list.pushQuad(quad());list.pushQuad(quad());
    const text={...carrier(),parentId:"group"};
    const plan={primitives:[{id:"a",index:0,parentId:"group"},{id:"b",index:1,parentId:"group"}],
      groups:[{id:"group",firstIndex:0,endIndex:2,transform:[1,0,0,1,0,0],cacheAsTexture:true}]};
    expect(r.admitScene(list,[text],plan).presented).toBe(true);
    const group=(renderSpy.mock.lastCall?.[0] as any).children[0],child=group.children[0].children[0];
    expect(group.renderGroup?.isCachedAsTexture).toBe(true);
    expect(child.renderGroup?.isCachedAsTexture).toBe(true);
    expect(r.patchScene({groups:[{id:"group",alpha:.5}]}).presented).toBe(true);
    expect(group.renderGroup?.isCachedAsTexture).toBe(false);expect(child.renderGroup?.isCachedAsTexture).toBe(false);
    expect(r.textOutcomes()).toMatchObject({actual:"slug",slug:1,slugCached:0});
    expect(r.patchScene({groups:[{id:"group",alpha:1}]}).presented).toBe(true);
    expect(r.presentScene().presented).toBe(true);
    expect(group.renderGroup?.isCachedAsTexture).toBe(true);
    expect(child.renderGroup?.isCachedAsTexture).toBe(true);
    r.dispose();
  });
  it("keeps deferred cache outcome pending after failed present, then retries",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug-cached",createGlyphProvider:()=>({pass:{drawRun:(view)=>({glyphs:view.glyphCount,drawCalls:1})},
        invalidate:vi.fn(),restore:()=>true,dispose:vi.fn()})});
    const list=createDrawList<string>(),texts=Array.from({length:5},(_,i)=>carrier(`label${i}`));
    expect(r.admitScene(list,texts,{primitives:[]}).presented).toBe(true);
    const prior=r.textOutcomes();
    renderSpy.mockImplementationOnce(()=>{throw new Error("cache draw failed")});
    expect(r.presentScene()).toEqual({presented:false,reason:"cache draw failed"});
    expect(r.textOutcomes()).toBe(prior);
    expect(r.presentScene().presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({slugCached:5,slug:0});
    r.dispose();
  });
  it("recovers slug after context restoration precedes provider readiness",async()=>{
    const canvas=document.createElement("canvas"),ready={value:false};
    const restore=vi.fn(()=>ready.value),invalidate=vi.fn();
    const r=await createPixiDrawListRenderer({canvas,width:100,height:50,textureUrl:(x:string)=>x,
      textMode:"slug",createGlyphProvider:()=>({pass:{drawRun:(view)=>({glyphs:view.glyphCount,drawCalls:1})},
        invalidate,restore,dispose:vi.fn()})});
    const list=createDrawList<string>(),text=carrier();
    expect(r.admitScene(list,[text],{primitives:[]}).presented).toBe(true);
    canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(r.admitScene(list,[text],{primitives:[]}).presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({native:1});
    ready.value=true;
    expect(r.admitScene(list,[text],{primitives:[]}).presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({slug:1,native:0});
    expect(restore.mock.calls.length).toBeGreaterThanOrEqual(3);
    r.dispose();
  });
  it("retains committed glyph and static RenderTextures through a failed alpha patch",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug-cached",createGlyphProvider:()=>glyphProvider()});
    const list=createDrawList<string>();list.pushQuad(quad());list.pushQuad(quad());
    const plan={primitives:[{id:"a",index:0,parentId:"group"},{id:"b",index:1,parentId:"group"}],
      groups:[{id:"group",firstIndex:0,endIndex:2,transform:[1,0,0,1,0,0],cacheAsTexture:true}]};
    expect(r.admitScene(list,[{...carrier(),parentId:"group"}],plan).presented).toBe(true);
    const group=(renderSpy.mock.lastCall?.[0] as any).children[0],child=group.children[0].children[0];
    const groupTexture=group.renderGroup.texture,glyphTexture=child.renderGroup.texture;
    renderSpy.mockImplementationOnce(()=>{throw new Error("failed alpha draw")});
    expect(r.patchScene({groups:[{id:"group",alpha:.5}]})).toEqual({presented:false,reason:"failed alpha draw"});
    expect(group.renderGroup.texture).toBe(groupTexture);expect(child.renderGroup.texture).toBe(glyphTexture);
    expect(controls.returnedTextures).not.toContain(groupTexture);expect(controls.returnedTextures).not.toContain(glyphTexture);
    // Both affine columns still have unit length; their new shear changes the
    // largest singular scale enough to suspend both caches.
    renderSpy.mockImplementationOnce(()=>{throw new Error("failed shear draw")});
    expect(r.patchScene({groups:[{id:"group",transform:[1,0,.6,.8,0,0]}]}))
      .toEqual({presented:false,reason:"failed shear draw"});
    expect(group.renderGroup.texture).toBe(groupTexture);expect(child.renderGroup.texture).toBe(glyphTexture);
    expect(controls.returnedTextures).not.toContain(groupTexture);expect(controls.returnedTextures).not.toContain(glyphTexture);
    expect(r.patchScene({groups:[{id:"group",alpha:.5}]}).presented).toBe(true);
    expect(controls.returnedTextures).toContain(groupTexture);expect(controls.returnedTextures).toContain(glyphTexture);
    r.dispose();
  });
  it("restores borrowed cache resources after failed structural admission and retires them on retry",async()=>{
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug-cached",createGlyphProvider:()=>glyphProvider()});
    const list=createDrawList<string>();list.pushQuad(quad());list.pushQuad(quad());
    const plan={primitives:[{id:"a",index:0,parentId:"group"},{id:"b",index:1,parentId:"group"}],
      groups:[{id:"group",firstIndex:0,endIndex:2,transform:[1,0,0,1,0,0],cacheAsTexture:true}]};
    expect(r.admitScene(list,[{...carrier(),parentId:"group"}],plan).presented).toBe(true);
    const group=(renderSpy.mock.lastCall?.[0] as any).children[0],child=group.children[0].children[0];
    const groupTexture=group.renderGroup.texture,glyphTexture=child.renderGroup.texture;
    renderSpy.mockImplementationOnce(()=>{throw new Error("failed replacement")});
    expect(r.admitScene(list,[{...carrier("label",.5),parentId:"group"}],plan))
      .toEqual({presented:false,reason:"failed replacement"});
    expect(group.renderGroup.texture).toBe(groupTexture);expect(child.renderGroup.texture).toBe(glyphTexture);
    expect(groupTexture.pooled).toBe(false);expect(glyphTexture.pooled).toBe(false);
    expect(r.admitScene(list,[{...carrier("label",.5),parentId:"group"}],plan).presented).toBe(true);
    expect(groupTexture.pooled).toBe(true);expect(glyphTexture.pooled).toBe(true);
    r.dispose();
  });
  it("keeps analytic Slug uncached and accepts inkless space slots",async()=>{
    const wake=vi.fn();
    const drawRun=vi.fn(()=>({glyphs:2,drawCalls:1}));
    const r=await createPixiDrawListRenderer({canvas:document.createElement("canvas"),width:100,height:50,
      textureUrl:(x:string)=>x,textMode:"slug",onInvalidate:wake,createGlyphProvider:()=>glyphProvider(drawRun)});
    const text=carrier();
    text.glyph!.block.slots=Int32Array.of(7,-1,8);
    text.glyph!.block.positions=Float32Array.of(1,2,3,4,5,6);
    text.glyph!.block.spans=Int32Array.of(0,3);
    renderSpy.mockImplementation((root:any)=>root.children[0].children[0].render((r.app as any).renderer));
    expect(r.admitScene(createDrawList<string>(),[text],{primitives:[]}).presented).toBe(true);
    expect(r.textOutcomes()).toMatchObject({requested:"slug",actual:"slug",slug:1,native:0});
    const child=(renderSpy.mock.lastCall?.[0] as any).children[0].children[0];
    expect(child.cacheAsTexture).not.toHaveBeenCalled();
    expect(r.presentScene().presented).toBe(true);expect(r.presentScene().presented).toBe(true);
    expect(child.cacheAsTexture).not.toHaveBeenCalled();expect(wake).not.toHaveBeenCalledWith("present");
    expect(drawRun).toHaveBeenCalled();r.dispose();
  });
  it("rebakes a retained cached glyph after context restoration",async()=>{
    const canvas=document.createElement("canvas");
    const r=await createPixiDrawListRenderer({canvas,width:100,height:50,textureUrl:(x:string)=>x,
      textMode:"slug-cached",createGlyphProvider:()=>glyphProvider()});
    const list=createDrawList<string>(),plan={primitives:[]},text=carrier();
    expect(r.admitScene(list,[text],plan).presented).toBe(true);
    const child=(renderSpy.mock.lastCall?.[0] as any).children[0].children[0],old=child.renderGroup.texture;
    canvas.dispatchEvent(new Event("webglcontextlost",{cancelable:true}));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(r.admitScene(list,[text],plan).presented).toBe(true);
    expect(child.renderGroup.texture).not.toBe(old);
    expect(child.cacheAsTexture).toHaveBeenCalledTimes(2);
    r.dispose();
  });
});
