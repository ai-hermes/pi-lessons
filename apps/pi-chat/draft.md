
server
    /api
        /system(health)
        /conversation
            POST   /
            GET    /:conversationId          history messageList
            POST   /:conversationId/messages hi formData
            GET    /:conversationId/stream?after=seqId SSE live messageList
frontend
    /   empyt state
    /conversation/:conversationId
            

pi-chat
    src -> fe
    shared -> fe/be shared
    server -> be


通过网盘分享的文件：tutorial-pi-chat.zip
链接: https://pan.baidu.com/s/1dLDyYHH-IgUKts8gjKiqvg 提取码: 8ch7 
--来自百度网盘超级会员v9的分享

https://finetunedb.com/tools/jsonl-viewer

wrapper:
- persistence: ConversationRecord(conversationId)
- pi session/runtime
- channel(sse) 

├── app-settings.json
├── exports
├── records
│   └── faab890b-3429-4058-83ed-8e161e94e44f.json
├── sessions
│   ├── 2026-08-26T00-51-03-661Z_faab890b-3429-4058-83ed-8e161e94e44f.jsonl
└── workspaces
    └── faab890b-3429-4058-83ed-8e161e94e44f
        ├── aapl_6month_analysis.md
        ├── nvda_6month_analysis.md
        └── README.md



createAgentSession
    |
createAgentSessionRuntime