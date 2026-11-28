#!/usr/bin/env python3
"""用真实方舟请求度量网关在流中断时的用量估算（AgentGateway tokenize）与 loom 的结算。

在 st2-aii 宿主机上运行（deploy/real/estimate.sh 负责拷贝与调用）。每个用例：
  1. 完整请求一次（stream + include_usage），取方舟报告的 prompt_tokens 作为输入真值；
  2. 同一请求再发一次，收到 ABORT_AFTER 个 chunk 后断开，触发网关按已转发内容估算用量；
  3. 读取 loom 对断开请求的结算（输入 / 输出 token、金额、计费依据）；
  4. 用方舟分词接口（/api/v3/tokenization，模型自己的词表）计算客户端收到的文本的真实 token 数，作为输出真值。
上游凭据从 Secret loom/ark-upstream-key 读入内存，不打印、不落盘。
"""

import http.client
import json
import os
import subprocess
import sys
import time

GATEWAY = ("127.0.0.1", 14001, "/ark/v1/chat/completions")
KEY = os.environ.get("LOOM_KEY", "loom-real-upstream-0000000000001")
ABORT_AFTER = int(os.environ.get("ABORT_AFTER", "40"))

# 与 configs/pricing.yaml 一致：nano-USD / token（倍率 × 2,000；输出再乘补全倍率）
PRICES = {
    "doubao-seed-2-0-lite-260428": (300.0, 600.0),
    "deepseek-v4-flash-ga-260731": (280.0, 784.0),
}

LONG_CONTEXT = "以下是关于杭州的资料，请仔细阅读。" + "杭州是浙江省省会，历史悠久，西湖、灵隐寺、京杭大运河都是著名景点。" * 40

CASES = [
    # name, model, extra body fields, prompt
    ("doubao 中文 关闭思考", "doubao-seed-2-0-lite-260428", {"thinking": {"type": "disabled"}},
     "请写一篇五百字左右的散文，主题是杭州的秋天。"),
    ("doubao 英文 关闭思考", "doubao-seed-2-0-lite-260428", {"thinking": {"type": "disabled"}},
     "Write a 400-word essay about autumn in Hangzhou, with concrete details."),
    ("doubao 中文 长上下文", "doubao-seed-2-0-lite-260428", {"thinking": {"type": "disabled"}},
     LONG_CONTEXT + "\n根据上述资料，写一篇四百字的导游词。"),
    ("doubao 代码 关闭思考", "doubao-seed-2-0-lite-260428", {"thinking": {"type": "disabled"}},
     "用 Go 写一个带过期时间的 LRU 缓存，包含完整代码和单元测试。"),
    ("doubao 中文 开启思考", "doubao-seed-2-0-lite-260428", {"thinking": {"type": "enabled"}},
     "一个水池有进水管和出水管，进水管 6 小时注满，出水管 9 小时放空，同时打开多久注满？请详细推理。"),
    ("deepseek 中文", "deepseek-v4-flash-ga-260731", {},
     "请写一篇五百字左右的散文，主题是杭州的秋天。"),
    ("deepseek 英文", "deepseek-v4-flash-ga-260731", {},
     "Write a 400-word essay about autumn in Hangzhou, with concrete details."),
]


def sh(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def kubectl(*args):
    return sh("kubectl", "-n", "loom", *args)


def psql(query):
    pod = kubectl("get", "pod", "-l", "cnpg.io/cluster=loom-pg,cnpg.io/instanceRole=primary", "-o", "name")
    return kubectl("exec", pod, "-c", "postgres", "--", "psql",
                   "postgresql://loom:loom@127.0.0.1:5432/loom", "-Atc", query)


def upstream_auth():
    import base64
    raw = kubectl("get", "secret", "ark-upstream-key", "-o", "jsonpath={.data.Authorization}")
    return base64.b64decode(raw).decode()


def body(model, extra, prompt):
    b = {"model": model, "max_tokens": 1500, "stream": True, "stream_options": {"include_usage": True},
         "messages": [{"role": "user", "content": prompt}]}
    b.update(extra)
    return json.dumps(b, ensure_ascii=False).encode()


def stream(payload, abort_after=None):
    """发送流式请求；abort_after 为 None 时读完，返回 (usage, chunks, content, reasoning)。"""
    conn = http.client.HTTPConnection(GATEWAY[0], GATEWAY[1], timeout=120)
    conn.request("POST", GATEWAY[2], payload, {"Authorization": f"Bearer {KEY}", "content-type": "application/json"})
    resp = conn.getresponse()
    if resp.status != 200:
        raise RuntimeError(f"status {resp.status}: {resp.read()[:300]!r}")
    usage, chunks, content, reasoning = None, 0, [], []
    while True:
        line = resp.readline()
        if not line:
            break
        line = line.decode("utf-8", "replace").strip()
        if not line.startswith("data:") or line == "data: [DONE]":
            continue
        chunk = json.loads(line[5:])
        usage = chunk.get("usage") or usage
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            if delta.get("content"):
                content.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
            if delta.get("content") or delta.get("reasoning_content"):
                chunks += 1
        if abort_after is not None and chunks >= abort_after:
            conn.sock.close()  # 主动断开：此时还没收到带 usage 的结束 chunk
            break
    conn.close()
    return usage, chunks, "".join(content), "".join(reasoning)


def true_tokens(auth, model, texts):
    """方舟分词接口：只计文本本身的 token（排除 BOS 等 offset 为空的特殊 token）。"""
    texts = [t for t in texts if t]
    if not texts:
        return 0
    conn = http.client.HTTPSConnection("ark.cn-beijing.volces.com", timeout=30)
    conn.request("POST", "/api/v3/tokenization", json.dumps({"model": model, "text": texts}).encode(),
                 {"Authorization": auth, "content-type": "application/json"})
    data = json.loads(conn.getresponse().read())
    total = 0
    for item in data["data"]:
        total += sum(1 for start, end in item["offset_mapping"] if end > start)
    return total


def latest_event(account_id, since):
    for _ in range(20):
        row = psql(
            "select input_tokens||'|'||output_tokens||'|'||cost_nanos||'|'||billing_basis "
            f"from usage_events where account_id = '{account_id}' and time >= to_timestamp({since}) "
            "order by time desc limit 1")
        if row:
            return row.split("|")
        time.sleep(0.5)
    return None


def pct(estimate, truth):
    return f"{(estimate - truth) / truth * 100:+.1f}%" if truth else "n/a"


def main():
    auth = upstream_auth()
    account_id = psql("select id from accounts where name = 'real-upstream'")
    results = []
    for name, model, extra, prompt in CASES:
        payload = body(model, extra, prompt)
        full_usage, _, _, _ = stream(payload)
        truth_in = full_usage["prompt_tokens"]
        since = int(time.time())
        _, chunks, content, reasoning = stream(payload, abort_after=ABORT_AFTER)
        time.sleep(3)
        event = latest_event(account_id, since)
        truth_out = true_tokens(auth, model, [reasoning, content])
        est_in, est_out, cost, basis = int(event[0]), int(event[1]), int(event[2]), event[3]
        price_in, price_out = PRICES[model]
        true_cost = round(truth_in * price_in + truth_out * price_out)
        results.append({
            "case": name, "chunks": chunks, "basis": basis,
            "input": {"estimate": est_in, "truth": truth_in, "error": pct(est_in, truth_in)},
            "output": {"estimate": est_out, "truth": truth_out, "error": pct(est_out, truth_out)},
            "cost": {"billed": cost, "truth": true_cost, "error": pct(cost, true_cost)},
        })
        r = results[-1]
        print(f"{name}\t{basis}\tin {est_in}/{truth_in} ({r['input']['error']})\t"
              f"out {est_out}/{truth_out} ({r['output']['error']})\tcost {cost}/{true_cost} ({r['cost']['error']})",
              flush=True)
    json.dump(results, open("/tmp/loom-estimate-results.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.exit(main())
