@echo off
chcp 65001 >nul
if "%~1"=="" if exist "%~dp0desktop-app\Stock Research System.exe" (
  start "" "%~dp0desktop-app\Stock Research System.exe"
  exit /b 0
)
echo ========================================
echo   股票深度研究系统 - 启动中...
echo ========================================
echo.

rem 预检：缺 Node 或依赖时给出可执行提示，避免 npx 联网兜底后两个窗口一片报错
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请安装 Node 24 及以上版本后重试。
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\" (
  echo [错误] 未安装依赖 node_modules。
  echo        请先在本目录执行：npm ci --legacy-peer-deps
  pause
  exit /b 1
)

rem 端口预检：被占用时立刻失败。否则健康探针会命中上一次遗留的实例，脚本会误报就绪
netstat -ano | findstr /R /C:":3001 .*LISTENING" >nul
if not errorlevel 1 (
  echo [错误] 端口 3001 已被占用，请先关闭占用进程（可用 netstat -ano 查看 PID）。
  pause
  exit /b 1
)
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if not errorlevel 1 (
  echo [错误] 端口 5173 已被占用，请先关闭占用进程。
  pause
  exit /b 1
)

echo [1/2] 启动后端服务 (端口 3001)...
cd /d "%~dp0server"
start "Stock-Backend" cmd /k "npx tsx watch src/index.ts"

set "BACKEND_OK=0"
set "HEALTH_FILE=%TEMP%\stock-health-%RANDOM%.txt"
echo.
echo 等待后端服务就绪（首次冷启动需加载股票库并探测行情源，最长等待 90 秒）...
set /a BACKEND_WAIT=0
:wait_backend
timeout /t 1 /nobreak >nul
set /a BACKEND_WAIT+=1
rem health 在行情源不可达时会返回 503，但进程已就绪——用状态码判断，不能只看 curl 的退出码
curl -s -o nul -w "%%{http_code}" http://localhost:3001/api/health > "%HEALTH_FILE%" 2>nul
set "HEALTH_CODE="
set /p HEALTH_CODE=<"%HEALTH_FILE%"
if "%HEALTH_CODE%"=="200" set "BACKEND_OK=1"
if "%HEALTH_CODE%"=="503" set "BACKEND_OK=1"
if "%BACKEND_OK%"=="1" goto backend_ready
if %BACKEND_WAIT% GEQ 90 goto backend_timeout
goto wait_backend

:backend_ready
if "%HEALTH_CODE%"=="503" (
  echo 后端进程已就绪；健康检查返回 503（行情源或缓存暂不可用），页面会提示降级，稍后自动恢复。
) else (
  echo 后端服务已就绪。
)
goto backend_done

:backend_timeout
echo.
echo [失败] 等待 90 秒后端仍未就绪，请检查上方 Stock-Backend 窗口中的报错信息。
echo        前端仍会启动，但页面会提示“无法连接后端服务”。
echo.
goto backend_done

:backend_done
del "%HEALTH_FILE%" >nul 2>nul

echo.
echo [2/2] 启动前端服务 (端口 5173)...
cd /d "%~dp0client"
rem 默认只监听回环地址（127.0.0.1）。确需局域网访问时：先设置 API_AUTH_TOKEN，
rem 再把下面的 npx vite 改为 npx vite --host。
start "Stock-Frontend" cmd /k "npx vite"

set "FRONTEND_OK=0"
echo.
echo 等待前端服务就绪（Vite 首次启动需预构建依赖，可能需 10 秒左右）...
set /a FRONTEND_WAIT=0
:wait_frontend
timeout /t 1 /nobreak >nul
set /a FRONTEND_WAIT+=1
curl -s -o nul http://localhost:5173 2>nul
if not errorlevel 1 set "FRONTEND_OK=1"
if "%FRONTEND_OK%"=="1" goto frontend_ready
if %FRONTEND_WAIT% GEQ 90 goto frontend_timeout
goto wait_frontend

:frontend_ready
echo 前端服务已就绪。
goto frontend_done

:frontend_timeout
echo.
echo [失败] 等待 90 秒前端仍未就绪，请检查上方 Stock-Frontend 窗口中的报错信息。
echo        后端接口可直接访问：http://localhost:3001
echo.
goto frontend_done

:frontend_done
echo.
if not "%BACKEND_OK%"=="1" goto launch_failed
if not "%FRONTEND_OK%"=="1" goto launch_failed

echo ========================================
echo   启动完成！
echo   前端: http://localhost:5173
echo   后端: http://localhost:3001
echo ========================================
echo.
start http://localhost:5173
exit /b 0

:launch_failed
echo ========================================
echo   启动未完成（见上方警告）
echo   修复后重新运行本脚本即可；已启动的窗口可手动关闭。
echo ========================================
echo.
exit /b 1
