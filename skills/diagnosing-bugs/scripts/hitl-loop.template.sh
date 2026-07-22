#!/usr/bin/env bash
# 人机协作的复现循环。
# 复制此文件，编辑下方步骤后运行。
# 代理运行脚本；用户在终端中按照提示操作。
#
# 用法：
#   bash hitl-loop.template.sh
#
# 两个辅助函数：
#   step "<instruction>"          → 显示指令并等待回车
#   capture VAR "<question>"      → 显示问题并将回答读入 VAR
#
# 最后，将捕获的值以 KEY=VALUE 形式输出，供代理解析。

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

# --- 在此处编辑 ---------------------------------------------------------

step "打开 http://localhost:3000 上的应用并登录。"

capture ERRORED "点击“Export”按钮。是否抛出错误？（y/n）"

capture ERROR_MSG "粘贴错误消息（或输入“none”）："

# --- 在此处以上编辑 -----------------------------------------------------

printf '\n--- 已捕获 ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
