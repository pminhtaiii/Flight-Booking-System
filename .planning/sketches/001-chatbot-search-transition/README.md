---
sketch: 001
name: chatbot-search-transition
question: 'How should the screen split and transition when flight search results are loaded?'
winner: C
tags: [layout, transition, chat]
---

# Sketch 001: Chatbot-Search Transition

## Design Question

How should the screens split and transition when flight search results are loaded?

## How to View

Open [index.html](file:///c:/Booking%20Systems/.planning/sketches/001-chatbot-search-transition/index.html) in your browser.

## Variants

- **Variant A: Split View Slide**
  - Chat starts centered in the viewport. When a search is triggered, the chat container slides to the left (taking up 35% of the viewport width) and the results area slides in from the right (65% width).
- **Variant B: Floating Tray Collapse**
  - Chat starts centered. When search completes, the chat container minimizes into a small floating tray in the bottom left, and the flight search results expand to fill the entire workspace.
- **Variant C: Modern Split Refined ★ Selected Winner**
  - Synthesizes Variant A's split sliding layout but upgrades it with an ultra-smooth layout transition using GPU-accelerated width scaling, opacity fading, and viewport perspective.
  - Upgrades the chatbot UI to a modern ChatGPT-style conversational feed: clean pill-shaped input, circle send button, borderless user bubble featuring a gorgeous purple gradient (`linear-gradient(135deg, #7C5CFC, #633BF7)`), and cleaner flight results card layouts.

## What to Look For

1. The transition smoothness from the centered single chat panel to the search state.
2. Screen space allocation — does Variant C feel balanced and modern?
3. Visual aesthetics of the ChatGPT-like chat bubbles, circle send buttons, and card borders.
