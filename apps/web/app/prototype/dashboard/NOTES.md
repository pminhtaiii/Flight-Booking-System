# Prototype: Wayfinder Dashboard (Glassmorphic SaaS MVP)

## Question

What should the Wayfinder user dashboard look like to provide rich flight management, quick actions, and AI insights with a modern, high-contrast Glassmorphic aesthetic without feeling cluttered?

## Stitch MCP Screen

- **Project ID**: `13084924633373309967`
- **Active Screen Resource**: `projects/13084924633373309967/screens/69ae01acbacf4a6da08c37370416e52c`
- **Screen ID**: `69ae01acbacf4a6da08c37370416e52c`
- **Title**: `Wayfinder Dashboard`
- **Design System Asset**: `assets/f3a3a4a8638448bcaf25c6d4c42ed87c`
- **Live Preview URL**: [Stitch Preview Image](https://lh3.googleusercontent.com/aida/AEtjO1UdF6EPyNJ0dELL14EyZt5vLcYwcqhV0hE5rJcsTOdFPtGPq2i8n8CgNz1mdzjmgB_yV970UFJuIqredDaqQsC6xhgh8lQpSQYz7TtmlQTuT4j45khJzY0Ra1eZhNGIGJrJ_QN-EhkPqFGOHojRC82u4qwt5bfy8PoN17pdV4-2sDqfwe4Ij5rP8siBJijnebWPCwEWzzFtRnbawMvSEtXFe6CYmYgJKlpwbV-YGmoRsCi5TawNRBzhYAHe)

## Visual Architecture & Tokens

- **Theme**: Light Atmospheric Depth
- **Palette**: Primary Ice Blue `#99CCFF`, Deep Sky Accent `#2B628F`, Action Blue `#0051D5` / `#2563EB`, Surface Slate `#111C2D`.
- **Surface**: `rgba(255, 255, 255, 0.65)` with `backdrop-filter: blur(24px)` and 1px refractive borders `rgba(255, 255, 255, 0.4)`.
- **Layout Structure**: Fixed `SideNavBar` on desktop + sticky `TopNavBar` + 2-column top and bottom split content grid.

## Variants

- **Variant 1 (`?variant=glassmorphic`)**: Atmospheric Depth (Synchronized with Stitch Screen `69ae01acbacf`).
- **Variant 2 (`?variant=command`)**: Flightdeck Executive (Compact telemetry metrics and rapid shortcuts).
- **Variant 3 (`?variant=zenith`)**: Zenith Minimalist (Serene editorial horizon layout).
