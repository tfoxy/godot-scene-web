# basis_universal (vendored)

Per this repository's rule, a vendored third-party tree is digest-pinned with its license and
provenance beside it. Added by G8kv (texture-delivery-design.md D15, fork K1).

- **Upstream:** https://github.com/BinomialLLC/basis_universal, version 1.60, commit
  `323239a6a5ffa57d6570cfc403be99156e33a8b0`, Apache-2.0 (`LICENSE`, sha256
  `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`).
- **Copied from:** `../godot-4.5.1-stable/thirdparty/basis_universal` (tag `4.5.1-stable`, commit
  `f62fdbde15035c5576dad93e586201f4d41ef0cb`), the copy Godot 4.5.1 vendors, so the host encoder, the
  GSW transcoder, the native receiver and the web export run one transcoder revision. Nothing was
  downloaded.
- **Godot's patches** (applied in the copied files; the patch files are in `patches/`, from
  `thirdparty/README.md`): `0001-external-zstd-pr344` (GH-73441: include the external zstd),
  `0002-external-tinyexr` (GH-97582), `0003-remove-tinydds-qoi` (GH-97582), `0004-ambiguous-calls`
  (GH-103968), `0005-msvc-include-ctype` (GH-106155). Godot's copy already omits
  `encoder/3rdparty/{qoi.h,tinydds.h,tinyexr.cpp,tinyexr.h}`.
- **One local patch, `patches/0006-render-stream-no-exr.patch`:** `encoder/basisu_enc.cpp` guards its
  tinyexr include and the three EXR read/write functions behind `BASISU_NO_EXR`, which the capture
  build defines, so tinyexr (Godot's separate third-party tree) is not vendored. The capture encodes
  LDR RGBA8 from memory and never reads or writes EXR. Without the define the file is Godot's, byte
  for byte (sha256 of Godot's `basisu_enc.cpp`
  `f310b731f25633314eeebf867aa4f883048fac4e65a99bf9370de89ba7890779`).
- **zstd** is not here: the transcoder and the KTX2 supercompression use `../../capture/vendor/zstd`
  (1.5.7, G8kz, `capture/vendor/PROVENANCE.md`) through the include path.

## Dropped from Godot's copy

Only files nothing in this build can reach, each behind a define the build sets to 0: the transcoder
tables `basisu_transcoder_tables_atc_55.inc`, `_atc_56.inc`, `_pvrtc2_45.inc` and
`_pvrtc2_alpha_33.inc` (`BASISD_SUPPORT_ATC=0`, `BASISD_SUPPORT_PVRTC2=0`, as Godot's own SCsub sets
them) and `encoder/basisu_ocl_kernels.h` (`BASISU_SUPPORT_OPENCL=0`: no OpenCL, no other optional
backend). Everything else, including the HDR encoders, is kept because `basisu_comp.cpp` and
`basisu_enc.cpp` reference it; the wrapper only ever requests UASTC LDR 4x4. The build lists the
encoder files as Godot's SCsub does (`capture/CMakeLists.txt`, target `grc_basisu`).

## File digests (sha256, the files as vendored)

```
0c6f2f7856071a8a0ed354d42ca0081321c49534f06b4e33284e84d1ea446b5f  encoder/3rdparty/android_astc_decomp.cpp
7b2c3216bd2adbe9e5bf35eb48d85a17bd863c17b9a705c76358020ad8709bd5  encoder/3rdparty/android_astc_decomp.h
b4128d6f4167717666ba0492f18d159d718559f0b28b79daa9b044372308defd  encoder/basisu_astc_hdr_6x6_enc.cpp
95ef07e27338909f7dce289d957c5f71c6e0227d76327fe70cba1282c37b5578  encoder/basisu_astc_hdr_6x6_enc.h
e8feb18210666873ba6dc2be44c29364a96d1632770b549349b639f6f38dfd3b  encoder/basisu_astc_hdr_common.cpp
19a2e34e046233208c0b580a14c8bfa600a11a0cecb82ba23732376f2e71784a  encoder/basisu_astc_hdr_common.h
e72f7f83480973566e3c019ffa21de254fd610bf447e920149977f3a92df57dc  encoder/basisu_backend.cpp
5fa08c10eb568d102499a636b0bce9f2d9dec5b2d0d430c37ac9fb8400ba1635  encoder/basisu_backend.h
ddb995292959935cde430cf9ea0f6a335caf3c233abff4fae8d028ad2680503b  encoder/basisu_basis_file.cpp
82367521e880b2aea65345e8e0930b5db4d339b5e3b4ea8b7a75f94685096493  encoder/basisu_basis_file.h
25c6f333fd05edc237ecc91acef206ab29aa168819a405373b9f490555712042  encoder/basisu_bc7enc.cpp
ba2ffd3efd114af5fad06f97eb2e12df9dd523a36c95e946f3d671c404d45a93  encoder/basisu_bc7enc.h
827e6817c4bf1ac7780843e17ac11c7af725b2d283e790f252514fb786666915  encoder/basisu_comp.cpp
e29b47eec8a7a5594c587d872a4def578a9bf3ba15abe9f1e92c6bee0e2fe520  encoder/basisu_comp.h
2d34a357e73b16e5ad9d7456dea957fd7eb45035dd6a07d34550649e84e200b8  encoder/basisu_enc.cpp
9efed7589a8641e88726e393b075c79a720f12692e7a7f1d659cbbc41d3a89d7  encoder/basisu_enc.h
273d236e200e6acf7e574030f9b2bc48f7284c2c8d5bbff24f5de0b037dce378  encoder/basisu_etc.cpp
cd8a1c4b8cccec9778af924fcf68d258f4a4bd035b11db557f439afea1d20be5  encoder/basisu_etc.h
f23103719485cbbc477042a13eea24d20a4e34ae7b61f7f2a92a439ecc73481d  encoder/basisu_frontend.cpp
04431c0adb2b30438495fdc97e60ada7c483968ffa8c5b9df9b3589f4237655b  encoder/basisu_frontend.h
bb829c99a45ffc8379cccc5850dc1b4fba1bacd5b05197a1029f1a7f4404ae33  encoder/basisu_gpu_texture.cpp
4a760e6bfb9359863ae3b5bc1dcda464b09c4d1e4a048dd01d53222aaa2262b9  encoder/basisu_gpu_texture.h
8cc894e849bb8634d66aa934336d2e4fcd1fdabb6b8ce27eb0611f0e64be2feb  encoder/basisu_kernels_declares.h
7f796e18acc4c8812672687843c1fbb3f2ecfc2a1f842373be7c4c29594e6c3b  encoder/basisu_kernels_imp.h
155af97bfcef5da2800042b9df3b98ef8e7990d96ceb1227382c436411935b46  encoder/basisu_kernels_sse.cpp
b5620d9aacde82790ca84a22f0387a9ca06448f47bbd6fe3630caa05336cd4f3  encoder/basisu_math.h
9deea711d5c071e1ac71387a3c24b5fc758e824ba6764e717973fa3d264d059f  encoder/basisu_miniz.h
5e28b534a1b709057570b1e027f6f29750d04e7e6aec5c2356b905c655224a34  encoder/basisu_opencl.cpp
d12758701854931e3a2f647e5be960cff9500d521aad7b21d595d8f7d9a1c7b0  encoder/basisu_opencl.h
61f513f58d4c465cc9f437ecd9d4ec17aa3f7e824081125ed5625b42be7e2b5d  encoder/basisu_pvrtc1_4.cpp
00ed2854e62a4a6b099e33abda4d507f8fa70ba20a81112753d8e8a8d07a95d8  encoder/basisu_pvrtc1_4.h
3bdfa76f0d21d6bb7f6249fb515d0fc6dfc64061de84cf006067fcfef0ea85ae  encoder/basisu_resample_filters.cpp
9bf73dc390459e4f105591d844ef97c2307d6ad548801bac5558b6d7640048d5  encoder/basisu_resampler.cpp
b69dd4d297b69365c8246a162eddea9526706f16a2dae7775b76479c06395201  encoder/basisu_resampler_filters.h
0f157726034d750267b3e62c0b001cc2e32057e90aaa26ce25e98d8f7f40c0a2  encoder/basisu_resampler.h
568436d7be06172b1749f99cdd6f49c1b57f6466701ca8a5527a0b9b3f6a6ca2  encoder/basisu_ssim.cpp
8ec3677b5be06844ed5131f44e4e858dd194145caa805b48898bbc2c0dcee173  encoder/basisu_ssim.h
d200823236bbc26791c04426fbd3b9254e3e2008c926100e025f70d63df5f5d7  encoder/basisu_uastc_enc.cpp
c5f0c8c29e9c22cbe20931182a5c941f4ed94fe4f94299e8602198e4b1e5cd3c  encoder/basisu_uastc_enc.h
0de38c3d1438eb63f610b7bf7287fb7cb3c495af5b2813542fa66892f43a5c92  encoder/basisu_uastc_hdr_4x4_enc.cpp
430f7a590a55aad862106107bf539542e6d927ca7a191894bc1e671393f59675  encoder/basisu_uastc_hdr_4x4_enc.h
6d683e36f083909460e952fe92911271066a68abde9ae01c4346ec72fb13deb4  encoder/cppspmd_flow.h
0373e2bdc5c9923636de20fb16cd91cf2d79ba33ed0eb6aeae0419194d01dc30  encoder/cppspmd_math_declares.h
489b0258fe1307d14e6b4a14bfef36784e7ccda2666fbec32307eae7ce2bd839  encoder/cppspmd_math.h
769916309c8289e634c6f7873f2c68477dfb33f5bc96ff83867a4578b15d266d  encoder/cppspmd_sse.h
dcff9416e208031155aa041cd0ffd7350839034f7a5bbb3293cb40ff3db865a0  encoder/cppspmd_type_aliases.h
3ad1299c433ab96996046bc97f342942cdf598784fb2388939c7f2a7276e0a43  encoder/jpgd.cpp
d4f46e1eb77b38f3d9a4bab88be8ed6dd2ee1a72b8efe23020d2711d51d9d407  encoder/jpgd.h
a6e48d750f68dc58f60e8be55aae957cd36a1e3bd46b76776b56cf62277d4167  encoder/pvpngreader.cpp
2f3f5cb1dde74dabfc5c2b7d569f621548c8eb820261181f39f37292522fb23e  encoder/pvpngreader.h
4da0f64b283a037d90ff9f4770495b234ea3b51bbe97e23a219e79eef3692a9e  patches/0001-external-zstd-pr344.patch
e07f864858bd48dbf738769142fff3688d2dd19fc6c9b59efd280e6407b454dc  patches/0002-external-tinyexr.patch
2a2f635f9ddff7460c725ff6076258ad525ad5c0f71aeb1cdc9291296809756b  patches/0003-remove-tinydds-qoi.patch
ea174161cd815a3bd6bef2d56ec049494eb84dd70f3c8e3c41ccb38367234864  patches/0004-ambiguous-calls.patch
0bdefacc2ac8d0cb69a4512dd29207e29ec6a0fbe936319e0aadc37dbe6ffe37  patches/0005-msvc-include-ctype.patch
16cdbba3fa62b32607bd255640f802d114c3fc596ce1e8c79c1565213dfd37d8  patches/0006-render-stream-no-exr.patch
163f459ca0712b0e7da4a4af95e9f11028417ab2d7507c7f2545c02595b3a7e6  transcoder/basisu_astc_hdr_core.h
203c3335bc8a3136a726d6b246ab68413765628a765af005a5d822d72d231211  transcoder/basisu_astc_helpers.h
5eac0e25633cfb842f8f363ed2bd13339177ca770315faac51fd3d9595c97885  transcoder/basisu_containers.h
8e0ca132627355fc6a2f6d3fda7095252d11cb7c1ff79b76799cbf7916ac27a0  transcoder/basisu_containers_impl.h
6c5511c25fde9ebb1bd12e7f803d353b7d8e25481a542a88c4447719ef91cc1a  transcoder/basisu_file_headers.h
f747782810775f3bc171c05d8399db86a3b232b3214d35bd7d9ad95b4a04a4db  transcoder/basisu.h
d4a7119363b6d2668748831738a3ae7f45411234d4dd4cff15e7cf604abd2aaf  transcoder/basisu_transcoder.cpp
23eae10fd5c10d77f59b38530ac4dc473b63883fc73f0ac21c6ccec1d2e4b4cb  transcoder/basisu_transcoder.h
4baaac7752526e74ee1875d512182762422edb77ee9572b9e44eadfe17a4183b  transcoder/basisu_transcoder_internal.h
f41acb498be64349c48600e965664f4bec1161781169e3ec3411827c490ef4f8  transcoder/basisu_transcoder_tables_astc_0_255.inc
7dd41c648d3ed8e7d511eb4af865669c4dd50b8ecead62a68fca471138c46e1a  transcoder/basisu_transcoder_tables_astc.inc
4d713b839594f429d95f329d60f8ad495e932619111b5dfddffb688e3634b495  transcoder/basisu_transcoder_tables_bc7_m5_alpha.inc
e6f63d3ebce0ac84d801ec54614b6a4eeda3be3e994f3abbfc732377cfe5a531  transcoder/basisu_transcoder_tables_bc7_m5_color.inc
500e640b5e6858fd10194eb4845670eb36d3ef9dc117a017632c1104ba3eb9d5  transcoder/basisu_transcoder_tables_dxt1_5.inc
3d203465f9097845eddb821943d312bf8cffb04d8f5ce09c18d4c6df40519ed3  transcoder/basisu_transcoder_tables_dxt1_6.inc
9f8fa061e1f6e9ae1169b091b6040271a1baf1f426557e3635d73cc408ead81d  transcoder/basisu_transcoder_uastc.h
```
