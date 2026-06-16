<template>
  <RuntimeGraphPreview
    preview-id="home-circular-depedencies"
    :show-bright-line="false"
    collapsed-modules="PaymentModule,MobileModule,ProductModule"
    exclude-modules="NestJSCoreModule,AppModule,UserModule"
    height="clamp(18rem, 58vh, 34rem)"
    caption="Click a Warning chip to reveal the loop story."
  />
</template>
