@echo off
cd /d "%~dp0"
echo Publishing Game Zone to GitHub...
echo.
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  gh repo create games --public --source=. --push
  gh api repos/praseeda99/games/pages -X POST -f "source[branch]=main" -f "source[path]=/" >nul
) else (
  git add -A
  git commit -m "Update games"
  git push
)
echo.
echo Done! In about a minute, open this on your phone:
echo     https://praseeda99.github.io/games/
echo.
pause
