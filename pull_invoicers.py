import re
import json

s = open("/home/vault/saas-payment-bot/bot.ts").read()
i = s.find("KNOWN_INVOICERS")
block = s[i : i + 800]
addrs = re.findall(r"""["']([1-9A-HJ-NP-Za-km-z]{43,44})["']""", block)
seen = []
for a in addrs:
    if a not in seen:
        seen.append(a)
print(seen)
open("/home/vault/saas-payment-bot/invoicers.json", "w").write(json.dumps(seen[:4]))
