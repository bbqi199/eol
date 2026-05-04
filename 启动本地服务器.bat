@echo off
chcp 65001 >nul
title ECO-SHOP 本地服务器

echo ======================================
echo   ECO-SHOP 本地服务器启动中...
echo ======================================
echo.

::: 检查 Python 是否安装
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo [OK] 使用 Python 启动服务器...
    echo.
    echo 访问地址: http://localhost:8082/index.html
    echo 按 Ctrl+C 停止服务器
    echo.
    start "" "http://localhost:8082/index.html"
    cd /d "%~dp0"
    python -m http.server 8082
    goto :end
)

::: 检查 Node.js 是否安装
node --version >nul 2>&1
if %errorlevel% == 0 (
    echo [OK] 使用 Node.js 启动服务器...
    echo.
    echo 访问地址: http://localhost:8082/index.html
    echo 按 Ctrl+C 停止服务器
    echo.
    start "" "http://localhost:8082/index.html"
    cd /d "%~dp0"
    npx --yes http-server -p 8082 --cors
    goto :end
)

echo [错误] 未找到 Python 或 Node.js
echo.
echo 请安装其中一个:
echo   Python: https://www.python.org/downloads/
echo   Node.js: https://nodejs.org/
echo.
pause

:end
