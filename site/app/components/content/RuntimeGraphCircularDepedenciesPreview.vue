<template>
  <RuntimeGraphPreview
    preview-id="home-circular-depedencies"
    collapsed-modules="ProductModule,RecommendationModule,StoreProductModule"
    exclude-modules="NestJSCoreModule,AppModule,DatabaseModule,AuthModule,CustomerModule,CustomerLoyaltyModule,StoreModule,VoucherModule"
    height="clamp(18rem, 58vh, 34rem)"
    caption="Click a Warning chip to reveal the loop story."
  />
</template>
