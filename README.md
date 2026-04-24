# 103music Serverless

Fork from [win10ios/103music](https://github.com/win10ios/103music) with VIP song multi-source fallback fix.

## VIP Fix
When /song/enhance/player/url returns url=null, automatically tries /song/enhance/download/url with multi-bitrate cascade.