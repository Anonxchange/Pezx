---
name: Country preference migration
description: Approved product boundaries and conservative migration policy for visitor countries
---

Gift cards and top-ups share one digital country, separate from shop delivery
country and site language. Visitor detection only initializes unset preferences.

**Why:** The user approved one header menu while retaining independent digital
redemption and physical-delivery decisions; a visitor's location is not the
recipient's final purchase decision.

**How to apply:** Never propagate a digital selection into shop delivery or vice
versa. Keep entered recipient phone numbers unchanged on a country switch.

When historic digital shelf and header choices conflict, retain the explicit
header choice and disclose the conflict rather than silently guessing which
choice was newer. A saved unified manual preference always wins.

**Why:** Historic keys do not record timestamps, so recency cannot be reliably
inferred. Retaining the header value follows the existing header/browse behavior
while disclosing, rather than hiding, the older shelf conflict.

**How to apply:** Treat legacy values conservatively, allow confirmation in the
shared menu, and never let late visitor detection overwrite a manual selection.
