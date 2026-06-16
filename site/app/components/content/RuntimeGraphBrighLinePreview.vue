<template>
  <RuntimeGraphPreview
    preview-id="home-brigh-line"
    fix-bightline="UserRepository"
    exclude-modules="NestJSCoreModule,ProductModule,AppModule,MobileModule"
    :show-circular-dependencies="false"
    height="clamp(18rem, 58vh, 34rem)"
  />
</template>
