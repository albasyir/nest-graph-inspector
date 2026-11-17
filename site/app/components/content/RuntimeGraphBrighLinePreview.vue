<template>
  <RuntimeGraphPreview
    preview-id="home-brigh-line"
    fix-bightline="CustomerRepository"
    exclude-modules="NestJSCoreModule,AppModule,DatabaseModule,ProductModule,RecommendationModule,StoreModule,StoreProductModule,OrderModule,PaymentModule"
    :show-circular-dependencies="false"
    height="clamp(18rem, 58vh, 34rem)"
  />
</template>
