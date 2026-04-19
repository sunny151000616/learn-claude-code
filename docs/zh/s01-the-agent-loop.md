# s01: The Agent Loop (Agent 循环)

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"One loop & Bash is all you need"* -- 一个工具 + 一个循环 = 一个 Agent。
>
> **Harness 层**: 循环 -- 模型与真实世界的第一道连接。

## 问题

语言模型能推理代码, 但碰不到真实世界 -- 不能读文件、跑测试、看报错。没有循环, 每次工具调用你都得手动把结果粘回去。你自己就是那个循环。

## 解决方案

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> |  Tool   |
| prompt |      |       |      | execute |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                    (loop until stop_reason != "tool_use")
```

一个退出条件控制整个流程。循环持续运行, 直到模型不再调用工具。

## 工作原理

1. 用户 prompt 作为第一条消息。

```python
messages.append({"role": "user", "content": query})
```

2. 将消息和工具定义一起发给 LLM。

```python
response = client.messages.create(
    model=MODEL, system=SYSTEM, messages=messages,
    tools=TOOLS, max_tokens=8000,
)
```

3. 追加助手响应。检查 `stop_reason` -- 如果模型没有调用工具, 结束。

```python
messages.append({"role": "assistant", "content": response.content})
if response.stop_reason != "tool_use":
    return
```

4. 执行每个工具调用, 收集结果, 作为 user 消息追加。回到第 2 步。

```python
results = []
for block in response.content:
    if block.type == "tool_use":
        output = run_bash(block.input["command"])
        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": output,
        })
messages.append({"role": "user", "content": results})
```

组装为一个完整函数:

```python
def agent_loop(query):
    messages = [{"role": "user", "content": query}]
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

不到 30 行, 这就是整个 Agent。后面 11 个章节都在这个循环上叠加机制 -- 循环本身始终不变。

## 输出和执行流程的关系

用这个 prompt 举例:

```text
Create a file called hello.py that prints "Hello, World!"
```

终端里你会看到类似输出:

```text
s01 >> Create a file called hello.py that prints "Hello, World!"
$ pwd
/Volumes/OutsideDisk/sunxj_learning/learn-claude-code
$ echo 'print("Hello, World!")' > hello.py
(no output)
$ cat hello.py
print("Hello, World!")
$ python3 hello.py
Hello, World!
已创建文件 `hello.py`，内容如下：
```

这些输出不是同一种东西, 而是 4 类信息按循环顺序交替出现:

1. `s01 >> ...` 是主程序通过 `input()` 读到的用户输入。
2. `$ pwd`、`$ cat hello.py` 是 Agent 在执行工具前打印的“即将执行的命令”。
3. `/Volumes/...`、`Hello, World!`、`(no output)` 是 `run_bash()` 返回的真实命令输出。
4. 最后一行自然语言总结, 是模型停止调用工具后的最终回答。

对应代码如下:

```python
# 打印模型请求执行的命令
print(f"\033[33m$ {block.input['command']}\033[0m")

# 真正执行 bash 命令
output = run_bash(block.input["command"])

# 打印命令输出, 方便在终端观察执行轨迹
print(output[:200])
```

所以你在终端里看到的顺序, 本质上就是:

```text
用户输入
-> 模型请求 tool_use
-> 程序打印命令
-> 程序执行命令
-> 程序打印命令输出
-> 把 tool_result 塞回 messages
-> 模型决定下一步
-> ...
-> 模型不再调用工具, 输出最终答案
```

如果把 `messages` 的变化展开, 会更清楚:

```python
# 第 1 步: 用户提出任务
messages = [
    {"role": "user", "content": 'Create a file called hello.py that prints "Hello, World!"'}
]

# 第 2 步: 模型先请求执行 pwd
messages.append({
    "role": "assistant",
    "content": [
        {"type": "tool_use", "name": "bash", "input": {"command": "pwd"}}
    ],
})

# 第 3 步: 程序执行 pwd, 再把结果作为 tool_result 回传
messages.append({
    "role": "user",
    "content": [
        {"type": "tool_result", "content": "/Volumes/OutsideDisk/sunxj_learning/learn-claude-code"}
    ],
})

# 第 4 步: 模型再请求写文件、读文件、运行文件
# 第 5 步: 每次命令输出都会继续回填到 messages
# 第 6 步: 模型确认任务完成, 返回最终文本答案
```

一个很重要的观察是: 终端中的“命令轨迹”只是给人看的调试输出, 真正驱动下一步决策的是 `messages` 里追加进去的 `tool_result`。换句话说, **Agent 不是看终端继续思考, 而是看消息历史继续思考**。

## 变更内容

| 组件          | 之前       | 之后                           |
|---------------|------------|--------------------------------|
| Agent loop    | (无)       | `while True` + stop_reason     |
| Tools         | (无)       | `bash` (单一工具)              |
| Messages      | (无)       | 累积式消息列表                 |
| Control flow  | (无)       | `stop_reason != "tool_use"`    |

## 试一试

```sh
cd learn-claude-code
python agents/s01_agent_loop.py
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Create a file called hello.py that prints "Hello, World!"`
2. `List all Python files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`
