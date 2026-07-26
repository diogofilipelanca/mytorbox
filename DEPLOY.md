# Deploy no servidor Hetzner

Stack: **Caddy** (TLS automático) → **addon** (Node). O Caddy é o único serviço com portas
publicadas; o addon não é alcançável de fora.

**Sem Redis.** As caches (biblioteca, TMDB, parse do `guessit`, ficheiros de legenda) vivem
na memória do processo. Consequências:

- Um `restart` ou redeploy obriga a reconstruir a biblioteca do zero — o primeiro
  carregamento a seguir é lento, proporcional ao tamanho da biblioteca
- **Custom Streams não funcionam** — precisam de armazenamento persistente
- O dashboard `/stats` não tem dados (mostra "no storage configured")

Nada disto é erro: o addon trata a ausência de Redis como caso normal. Se um dia quiseres
ativá-lo, basta acrescentar o serviço ao compose e preencher `REDIS_URL`.

---

## 0. Pré-requisito: um nome de domínio

O Stremio exige **HTTPS** para addons remotos, e o Let's Encrypt **não emite certificados
para IPs**. Precisas de um nome DNS a apontar para o servidor.

**Se tens domínio** — cria um registo A:

```
mytorbox.oteudominio.com.   A   178.105.251.154
```

**Se não tens** — o `nip.io` resolve qualquer subdomínio para o IP embutido, sem registo:

```
178.105.251.154.nip.io
```

Funciona e o Let's Encrypt emite para ele. Ressalva: como é um serviço partilhado por muita
gente, ocasionalmente esbarra nos limites de emissão do Let's Encrypt. Para uso permanente,
um domínio próprio (~10 €/ano) é mais fiável.

Confirma a propagação antes de avançar — o Caddy falha a emissão se o DNS ainda não resolver:

```bash
dig +short mytorbox.oteudominio.com    # tem de devolver 178.105.251.154
```

---

## 1. Docker no servidor

```bash
ssh root@178.105.251.154

curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

## 2. Firewall

Só 22, 80 e 443. O 7000 do addon **nunca** deve estar exposto — ver a nota de segurança
no fim.

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Se usares a Cloud Firewall da Hetzner, aplica as mesmas três regras lá (é preferível —
filtra antes de chegar à VM).

## 3. Código e configuração

```bash
git clone https://github.com/<o-teu-fork>/mytorbox.git /opt/mytorbox
cd /opt/mytorbox
cp .env.example .env
```

Edita o `.env`:

```bash
DOMAIN=mytorbox.oteudominio.com
BASE_URL=https://mytorbox.oteudominio.com

# As tuas chaves como defaults -> instalas por /manifest.json, sem credenciais no URL
TORBOX_API_KEY=<a-tua-chave-torbox>
TMDB_API_KEY=<a-tua-chave-tmdb>

TRUST_PROXY_HOPS=1

# Vazio — sem Redis, cache em memória
REDIS_URL=

# Opcional sem Redis: o /stats não tem dados de qualquer forma.
# Continua a proteger o POST /api/cache/clear, que limpa as caches em memória.
ADMIN_SECRET=

# ESTE é obrigatório: sem ele, quem descobrir o URL usa a tua conta TorBox.
ADDON_ACCESS_TOKEN=<openssl rand -hex 32>
```

Gera os dois segredos:

```bash
openssl rand -hex 32
```

Protege o ficheiro — contém as tuas chaves de API:

```bash
chmod 600 .env
```

## 4. Arrancar

```bash
docker compose up -d --build
docker compose logs -f caddy      # confirma a emissão do certificado
```

A primeira emissão demora alguns segundos. Quando vires `certificate obtained successfully`,
está pronto.

## 5. Instalar no Stremio

```
https://mytorbox.oteudominio.com/manifest.json?token=<ADDON_ACCESS_TOKEN>
```

Abre esse URL no browser para confirmar que devolve JSON, e depois cola-o no Stremio em
**Addons → Add addon**. As legendas passam a aparecer nos itens que o TMDB conseguiu
identificar.

---

## Operação

```bash
docker compose logs -f addon      # logs da aplicação
docker compose restart addon      # reiniciar
docker compose pull && docker compose up -d --build    # atualizar
docker compose down               # parar
```

O dashboard `/stats` está restrito a localhost pelo `Caddyfile`. Para lhe aceder, faz um
túnel SSH em vez de o expores:

```bash
ssh -L 8080:127.0.0.1:80 root@178.105.251.154
# depois abre http://localhost:8080/stats
```

*(Se preferires acesso direto, remove o bloco `@admin` do `Caddyfile` — continua a exigir
o `ADMIN_SECRET` de qualquer forma.)*

---

## Nota de segurança importante

O `TRUST_PROXY_HOPS=1` diz ao Express para aceitar **uma** entrada do `X-Forwarded-For`,
porque o Caddy escreve lá o IP real do cliente. Isso só é seguro enquanto o Caddy for a
**única** forma de chegar ao addon.

Por isso o serviço `addon` no `docker-compose.yml` **não tem `ports:`** — é deliberado, não
esquecimento. Se publicares a porta 7000 no host, qualquer pessoa pode contactar o addon
diretamente e forjar esse header, o que anula todos os limites de rate limiting.

Há um teste que documenta este comportamento:

```bash
npm test
# "with one proxy configured, only that proxy's hop is honoured"
```

Se algum dia expuseres o addon sem proxy à frente, mete `TRUST_PROXY_HOPS=0`.
