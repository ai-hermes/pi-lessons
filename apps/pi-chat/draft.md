
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



curl -X POST http://localhost:4328/api/conversation

{
	"conversation": {
		"id": "7590e3b3-6f8e-4248-bf76-2e8367415927",
		"title": "New Conversation",
		"createdAt": "2026-08-31T07:03:46.380Z",
		"updatedAt": "2026-08-31T07:03:46.380Z",
		"workspaceDir": "/Users/aholic/.pi/agent/pi-chat/workspaces/7590e3b3-6f8e-4248-bf76-2e8367415927",
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
		"id": "f2bbde78-8c23-49e9-813b-e177cdf51370",
		"lastEventId": 0
	},
	"diagnostics": []
}


curl -X POST http://localhost:4328/api/conversation/7590e3b3-6f8e-4248-bf76-2e8367415927/messages \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'text=hi'


curl -X GET http://localhost:4328/api/conversation/7590e3b3-6f8e-4248-bf76-2e8367415927/stream
