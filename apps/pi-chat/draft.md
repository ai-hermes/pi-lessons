server
/api
/system(health)
/conversation
POST /
GET /:conversationId history messageList
POST /:conversationId/messages hi formData
GET /:conversationId/stream?after=seqId SSE live messageList
frontend
/ empyt state
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
- pi session/runtime(sdk)
- channel(sse)

conversationId=faab890b-3429-4058-83ed-8e161e94e44f
root_dir
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

react hook(https://react.dev/reference/react/hooks)

curl -X POST http://localhost:4328/api/conversation
{
"conversation": {
"id": "31c2c56c-8a5b-4f74-a379-4c38df9ccdea",
"title": "New Conversation",
"createdAt": "2026-09-01T04:02:49.577Z",
"updatedAt": "2026-09-01T04:02:49.577Z",
"workspaceDir": "/Users/aholic/.pi/agent/pi-chat/workspaces/31c2c56c-8a5b-4f74-a379-4c38df9ccdea",
"status": "ready"
},
"messageList": [],
"model": {
"provider": "kimi-coding",
"id": "kimi-for-coding"
},
"thinkingLevel": "medium",
"availableThinkingLevels": ["off", "minimal", "low", "medium", "high"],
"status": "ready",
"stream": {
"id": "086af59d-8496-4e50-a9cb-78f6e766c75e",
"lastEventId": 0
},
"diagnostics": []
}

curl -X POST http://localhost:4328/api/conversation/31c2c56c-8a5b-4f74-a379-4c38df9ccdea/messages \
-H 'Content-Type: application/x-www-form-urlencoded' \
--data-urlencode 'text=hi'

curl -X GET http://localhost:4328/api/conversation/31c2c56c-8a5b-4f74-a379-4c38df9ccdea/stream

curl -X GET http://localhost:4328/api/conversation/31c2c56c-8a5b-4f74-a379-4c38df9ccdea
