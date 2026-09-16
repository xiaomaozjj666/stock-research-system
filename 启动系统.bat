@echo off
chcp 65001 >nul
echo ========================================
echo   股票深度研究系统 - 启动中...
echo ========================================
echo.

echo [1/2] 启动后端服务 (端口 3001)...
cd /d "%~dp0server"
start "Stock-Backend" cmd /k "npx tsx watch src/index.ts"

echo.
echo 等待后端服务就绪（首次冷启动需加载股票库并探测行情源，最长等待 90 秒）...
set /a BACKEND_WAIT=0
:wait_backend
timeout /t 1 /nobreak >nul
set /a BACKEND_WAIT+=1
curl -sf -o nul http://localhost:3001/api/health 2>nul
if not errorlevel 1 goto backend_ready
if %BACKEND_WAIT% GEQ 90 (
  echo.
  echo [警告] 等待 90 秒后端仍未就绪，请检查上方 Stock-Backend 窗口中的报错信息。
  echo        后端未就绪时前端页面会提示“无法连接后端服务”，就绪后刷新页面即可。
  echo.
  goto backend_timeout
)
goto wait_backend
:backend_ready
echo 后端服务已就绪。
:backend_timeout

echo.
echo [2/2] 启动前端服务 (端口 5173)...
cd /d "%~dp0client"
start "Stock-Frontend" cmd /k "npx vite --host"

echo.
echo 等待前端服务就绪（Vite 首次启动需预构建依赖，可能需 10 秒左右）...
echo （就绪后会自动打开浏览器；若迟迟未打开请按 Ctrl+C 后重新运行）
set /a FRONTEND_WAIT=0
:wait_frontend
timeout /t 1 /nobreak >nul
set /a FRONTEND_WAIT+=1
curl -s -o nul http://localhost:5173 2>nul
if not errorlevel 1 goto frontend_ready
if %FRONTEND_WAIT% GEQ 90 (
  echo.
  echo [警告] 等待 90 秒前端仍未就绪，请检查上方 Stock-Frontend 窗口中的报错信息。
  echo        前端未就绪时可通过 http://localhost:3001 直接访问后端接口，
  echo        前端窗口就绪后按 Ctrl+C 后重新运行本脚本即可。
  echo.
  goto frontend_timeout
)
goto wait_frontend
:frontend_ready
echo 前端服务已就绪。
:frontend_timeout

echo.
echo ========================================
echo   启动完成！
echo   前端: http://localhost:5173
echo   后端: http://localhost:3001
echo ========================================
echo.

start http://localhost:5173
