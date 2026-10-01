@echo off
set GOOGLE_APPLICATION_CREDENTIALS=e:\SEDS WEBSITE UPDATED SHIT\seds-pakistan-service-account.json
echo Starting Deployment with Service Account... > deploy_final_run_v2.txt
npx firebase deploy --only hosting,functions --non-interactive --project seds-pakistan --debug >> deploy_final_run_v2.txt 2>&1
echo Deployment Finished. >> deploy_final_run_v2.txt
