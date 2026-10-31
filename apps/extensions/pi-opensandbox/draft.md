## 整体展示
基础镜像使用 `crpi-a01fov5fxhl285uu.cn-shanghai.personal.cr.aliyuncs.com/warjiang/alpine:3.24.2`
aio使用`enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.11.0`,注意要配置启动脚本
aio=>https://sandbox.agent-infra.com/zh/guide/start/introduction

```
{
    "entrypoint": [
        "/opt/gem/run.sh"
    ]
}
```
1. 基础案例 创建一个python的快排程序写入到qsort.py，并执行测试，并把测试用来当做案例回写进去
2. 帮我总结下 https://my.feishu.cn/wiki/C9TIwfxmRiXvSBkZjIOcsAr6nee
3. 帮我调研下英伟达最近半年股价、市值的趋势，并通过网页的形式展示出来，最后给我一段对该公司的评价
4. 打开bilibili，搜索 【信使宝宝在教AI】 up主，帮我看看这个up主有多少分析，做了做少个视频


pi mcp add opensandbox --url \
     "http://10.37.25.80:8080/v1/sandboxes/c90c1813-53f2-43b8-80c9-0187ed631673/proxy/8080/mcp"


## 内置工具处理
内置工具拦截重定向sandbox执行 +系统提示词

## skill 处理
配置
```
{
    "skills": [
        {
            "sourceDir": "/Users/aholic/.agents/skills/lark-shared",
            "name": "lark-shared"
        },
        {
            "sourceDir": "/Users/aholic/.agents/skills/lark-doc",
            "name": "lark-doc"
        }
    ]
}
```
## 延迟加载 & resume
## ci + npm release