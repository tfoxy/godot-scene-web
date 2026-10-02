struct Globals { viewport: vec2<f32>, pad: vec2<f32> };
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var image0: texture_2d<f32>;
@group(1) @binding(1) var image1: texture_2d<f32>;
@group(1) @binding(2) var image2: texture_2d<f32>;
@group(1) @binding(3) var image3: texture_2d<f32>;
@group(1) @binding(4) var image4: texture_2d<f32>;
@group(1) @binding(5) var image5: texture_2d<f32>;
@group(1) @binding(6) var image6: texture_2d<f32>;
@group(1) @binding(7) var image7: texture_2d<f32>;
@group(1) @binding(8) var image_sampler: sampler;
struct In {
 @location(0) oa:vec4<f32>, @location(1) yu:vec4<f32>, @location(2) us:vec4<f32>,
 @location(3) color:vec4<f32>,
 @location(4) m0:vec4<f32>, @location(5) m1:vec4<f32>, @location(6) m2:vec4<f32>,
 @location(7) clip0:vec4<f32>, @location(8) clip1:vec4<f32>, @location(9) clip2:vec4<f32>,
 @location(10) cp0:vec2<f32>, @location(11) cp1:vec2<f32>, @location(12) cp2:vec2<f32>,
 @builtin(vertex_index) vertex_index:u32
};
struct Out {
 @builtin(position) pos:vec4<f32>, @location(0) uv:vec2<f32>, @location(1) color:vec4<f32>,
 @location(2) design_pos:vec2<f32>, @location(3) m0:vec4<f32>, @location(4) m1:vec4<f32>, @location(5) m2:vec4<f32>,
 @location(6) clip0:vec4<f32>, @location(7) clip1:vec4<f32>, @location(8) clip2:vec4<f32>,
 @location(9) cp0:vec2<f32>, @location(10) cp1:vec2<f32>, @location(11) cp2:vec2<f32>,
 @location(12) @interpolate(flat) slot:u32, @location(13) @interpolate(flat) mode:u32
};
@vertex fn vs(i:In)->Out {
 var o:Out;
 var corner=vec2<f32>(0.0,0.0);
 switch i.vertex_index {
  case 1u: { corner=vec2<f32>(1.0,0.0); }
  case 2u, 4u: { corner=vec2<f32>(1.0,1.0); }
  case 5u: { corner=vec2<f32>(0.0,1.0); }
  default: {}
 }
 let p=i.oa.xy+i.oa.zw*corner.x+i.yu.xy*corner.y;
 o.pos=vec4<f32>(p.x/globals.viewport.x*2.0-1.0,1.0-p.y/globals.viewport.y*2.0,0.0,1.0);
 o.uv=i.yu.zw+i.us.xy*corner;o.color=i.color;o.design_pos=p;
 o.m0=i.m0;o.m1=i.m1;o.m2=i.m2;
 o.clip0=i.clip0;o.cp0=i.cp0;o.clip1=i.clip1;o.cp1=i.cp1;o.clip2=i.clip2;o.cp2=i.cp2;
 o.slot=u32(i.us.z);o.mode=u32(i.us.w);
 return o;
}
fn inside(p:vec2<f32>,r:vec4<f32>,params:vec2<f32>)->bool {
 if params.x<0.0{return true;}
 let left=r.x-params.y;let right=r.x+r.z+params.y;let top=r.y;let bottom=r.y+r.w;
 if p.x<left||p.x>right||p.y<top||p.y>bottom{return false;}
 let radius=max(0.0,min(params.x,min((right-left)*0.5,(bottom-top)*0.5)));
 let nearest=clamp(p,vec2<f32>(left+radius,top+radius),vec2<f32>(right-radius,bottom-radius));
 return distance(p,nearest)<=radius+0.001;
}
fn median3(v:vec3<f32>)->f32 { return max(min(v.r,v.g),min(max(v.r,v.g),v.b)); }
@fragment fn fs(i:Out)->@location(0) vec4<f32> {
 if !inside(i.design_pos,i.clip0,i.cp0)||!inside(i.design_pos,i.clip1,i.cp1)||!inside(i.design_pos,i.clip2,i.cp2){discard;}
 var tex:vec4<f32>;
 switch i.slot {
  case 0u: { tex=textureSample(image0,image_sampler,i.uv); }
  case 1u: { tex=textureSample(image1,image_sampler,i.uv); }
  case 2u: { tex=textureSample(image2,image_sampler,i.uv); }
  case 3u: { tex=textureSample(image3,image_sampler,i.uv); }
  case 4u: { tex=textureSample(image4,image_sampler,i.uv); }
  case 5u: { tex=textureSample(image5,image_sampler,i.uv); }
  case 6u: { tex=textureSample(image6,image_sampler,i.uv); }
  default: { tex=textureSample(image7,image_sampler,i.uv); }
 }
 if i.mode == 1u || i.mode == 2u {
  let signed_distance=select(median3(tex.rgb),tex.r,i.mode == 2u)-0.5;
  let outline_distance=select(tex.a,tex.r,i.mode == 2u)-0.5;
  let unit_range=i.m0.x/max(i.m0.yz,vec2<f32>(1.0));
  let screen_tex_size=1.0/max(fwidth(i.uv),vec2<f32>(0.000001));
  let screen_range=max(0.5*dot(unit_range,screen_tex_size),1.0);
  let fill_coverage=clamp(signed_distance*screen_range+0.5,0.0,1.0);
  let outer_coverage=select(0.0,clamp((outline_distance+i.m0.w)*screen_range+0.5,0.0,1.0),outline_distance > -0.499);
  let fill_alpha=i.color.a*fill_coverage;
  let outline_alpha=i.m1.a*max(0.0,outer_coverage-fill_coverage);
  return vec4<f32>(i.color.rgb*fill_alpha+i.m1.rgb*outline_alpha,fill_alpha+outline_alpha);
 }
 let rgb=vec3<f32>(dot(i.m0.xyz,tex.rgb),dot(i.m1.xyz,tex.rgb),dot(i.m2.xyz,tex.rgb));
 return vec4<f32>(rgb*i.color.rgb*tex.a,tex.a*i.color.a);
}
// The picture pass already contains premultiplied color. Copy it unchanged.
@fragment fn fs_copy(i:Out)->@location(0) vec4<f32> {
 return textureSample(image0,image_sampler,i.uv);
}
