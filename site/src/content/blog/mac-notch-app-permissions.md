---
title: "Mac Notch App Permissions: What to Enable and Why"
description: "Which macOS permissions a notch / Dynamic Island app may request (calendar, mic, camera, Bluetooth) and how NotchOS asks only when you open a tool."
pubDate: 2026-11-11
tags: [permissions, privacy, mac, guide]
---

Installing a **Mac notch app** often triggers permission prompts. That is normal — the island needs access only for the tools you turn on.

## Common permissions

| Permission | Typical use in a notch app |
|------------|----------------------------|
| Calendar | Next meeting / agenda faces |
| Reminders / automation | Tasks |
| Microphone | Teleprompter voice features |
| Camera | Mirror / lighting check |
| Bluetooth | Accessory battery where supported |
| Accessibility / input | Some HUD or paste helpers (vendor-specific) |

## NotchOS approach

NotchOS aims to ask **when you open a face**, not dump every permission at first launch. Skip a tool and you should not need its permission.

We do not upload your clipboard or files for “cloud AI.” Writing tools are **on-device** when available. License checks talk to our license server only.

Read [Privacy](/privacy) and [Terms](/terms).

## Tips

1. Grant the minimum you use.  
2. Revoke unused permissions in **System Settings → Privacy & Security**.  
3. Prefer signed, notarized builds from the developer’s site ([Download](/download)).

Related: [Dynamic Island guide](/blog/dynamic-island-for-macbook) · [FAQ](/#faq)
