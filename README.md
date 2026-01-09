## 搭建步骤 ##

1.pages部署并绑定R2存储桶,变量名填`BUCKET`


2.worker部署`r2_worker.js`并绑定R2存储桶,变量名填`BUCKET`


3.pages添加变量

`PUBURL`:`your.worker.dev`


`username:userpass`:`*`


5.重试部署
