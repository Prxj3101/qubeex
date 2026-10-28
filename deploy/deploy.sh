#!/usr/bin/env bash
# Deploys the latest main branch on the Oracle server.
# Run by GitHub Actions over SSH (see .github/workflows/deploy.yml),
# or by hand on the server:  ~/qubeex/deploy/deploy.sh
#
# Everything is inside main() so bash reads the whole script before running it.
# (git reset below can replace this very file while it runs.)
set -euo pipefail

main() {
  cd "$HOME/qubeex"

  echo "==> Fetching latest code"
  git fetch --quiet origin main
  # Make the server copy exactly match GitHub. Untracked ignored files
  # (.env, deploy/.env) are not touched by this.
  git reset --hard --quiet origin/main
  echo "    now at: $(git log -1 --format='%h %s')"

  cd deploy
  echo "==> Building and restarting backend"
  docker compose up -d --build backend

  echo "==> Waiting for health check"
  for i in $(seq 1 20); do
    if docker compose exec -T backend node -e "fetch('http://localhost:3000/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      echo "    backend is healthy"
      echo "==> Cleaning old images"
      docker image prune -f >/dev/null
      echo "==> Deploy done"
      return 0
    fi
    sleep 3
  done

  echo "!! Backend did not become healthy in 60s. Last logs:"
  docker compose logs --tail 40 backend
  return 1
}

main "$@"
