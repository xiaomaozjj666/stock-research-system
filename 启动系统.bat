@echo off
chcp 65001 >nul
echo ========================================
echo   股票深度研究系统 - 启动中...
echo ========================================
echo.

echo [1/2] 启动后端服务 (端口 3001)...
cd /d D:\XIAOMAO\Projects\stock-research-system\server
start "Stock-Backend" cmd /k "npx tsx watch src/index.ts"

timeout /t 3 /nobreak >nul

echo [2/2] 启动前端服务 (端口 5173)...
cd /d D:\XIAOMAO\Projects\stock-research-system\client
start "Stock-Frontend" cmd /k "npx vite --host"

timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo   启动完成！
echo   前端: http://localhost:5173
echo   后端: http://localhost:3001
echo ========================================
echo.

start http://localhost:5173
