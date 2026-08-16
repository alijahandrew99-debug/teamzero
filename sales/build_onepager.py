# -*- coding: utf-8 -*-
"""Dawnpipe one-pager. Designed to be understood in a single read, by someone
standing next to a truck. Everything is drawn on one page on purpose."""
import os
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

# Version is stamped into the filename AND printed on the page. Two revisions
# went out under one filename and there was no way to tell them apart on
# screen, so the reader could not know which one they had open.
VERSION = 'v2'
STAMP = 'v2  ·  16 Aug 2026'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), f'Dawnpipe-One-Pager-{VERSION}.pdf')

PAPER = (0.957, 0.945, 0.918)   # #f4f1ea
INK   = (0.102, 0.094, 0.082)   # #1a1815
INK2  = (0.290, 0.275, 0.247)   # #4a463f
RED   = (0.753, 0.165, 0.106)   # #c02a1b
LINE  = (0.851, 0.827, 0.776)   # #d9d3c6
WHITE = (1, 1, 1)

W, H = LETTER
M = 54                      # margin
SERIF = 'Times-Roman'
SERIF_B = 'Times-Bold'
SERIF_I = 'Times-Italic'

c = canvas.Canvas(OUT, pagesize=LETTER)
c.setTitle('Dawnpipe — the AI that answers your phone')
c.setAuthor('Dawnpipe')
c.setSubject('AI receptionist for service businesses')


def rgb(t):
    return t


def text(x, y, s, font=SERIF, size=10.5, color=INK2, leading=None, width=None):
    """Draw text, wrapping to `width` if given. Returns the y after the block."""
    c.setFont(font, size)
    c.setFillColorRGB(*color)
    leading = leading or size * 1.35
    if width:
        for ln in simpleSplit(s, font, size, width):
            c.drawString(x, y, ln)
            y -= leading
        return y
    c.drawString(x, y, s)
    return y - leading


# ---------- background ----------
c.setFillColorRGB(*PAPER)
c.rect(0, 0, W, H, stroke=0, fill=1)

# top rule, in brand red
c.setFillColorRGB(*RED)
c.rect(0, H - 10, W, 10, stroke=0, fill=1)

y = H - 62

# ---------- wordmark ----------
c.setFont(SERIF_B, 27)
c.setFillColorRGB(*INK)
c.drawString(M, y, 'Dawn')
wm = c.stringWidth('Dawn', SERIF_B, 27)
c.setFillColorRGB(*RED)
c.drawString(M + wm, y, 'pipe')

c.setFont(SERIF, 10)
c.setFillColorRGB(*INK2)
c.drawRightString(W - M, y + 4, 'dawnpipe.com')
c.drawRightString(W - M, y - 9, '(213) 682-2616')

y -= 34
c.setStrokeColorRGB(*INK)
c.setLineWidth(1.6)
c.line(M, y, W - M, y)

# ---------- headline ----------
y -= 44
c.setFont(SERIF_B, 30)
c.setFillColorRGB(*INK)
c.drawString(M, y, 'Every missed call is a job')
y -= 34
c.drawString(M, y, 'someone else got.')

y -= 26
y = text(M, y, 'You are on a roof, under a sink, or with a customer. The phone rings and you cannot get to it. '
                'That caller does not leave a voicemail  —  they call the next name on the list.',
         size=12, leading=17, width=W - 2 * M)

# ---------- the arithmetic ----------
y -= 16
box_h = 100   # the payoff line must sit clear of the border, not on it
c.setFillColorRGB(*WHITE)
c.setStrokeColorRGB(*LINE)
c.setLineWidth(1)
c.roundRect(M, y - box_h, W - 2 * M, box_h, 8, stroke=1, fill=1)

c.setFillColorRGB(*RED)
c.rect(M, y - box_h, 4, box_h, stroke=0, fill=1)

inner = M + 22
ty = y - 26
c.setFont(SERIF_B, 12.5)
c.setFillColorRGB(*INK)
c.drawString(inner, ty, 'Do the arithmetic on your own business')
ty -= 20
c.setFont(SERIF, 11.5)
c.setFillColorRGB(*INK2)
c.drawString(inner, ty, 'Calls you miss in a week')
c.setFont(SERIF_B, 11.5)
c.setFillColorRGB(*INK)
c.drawRightString(W - M - 22, ty, '3')
ty -= 17
c.setFont(SERIF, 11.5)
c.setFillColorRGB(*INK2)
c.drawString(inner, ty, 'What one job is worth to you')
c.setFont(SERIF_B, 11.5)
c.setFillColorRGB(*INK)
c.drawRightString(W - M - 22, ty, '$400')
ty -= 8
c.setStrokeColorRGB(*LINE)
c.line(inner, ty, W - M - 22, ty)
ty -= 15
c.setFont(SERIF_B, 12)
c.setFillColorRGB(*RED)
c.drawString(inner, ty, 'Walking to your competitors, every month')
c.drawRightString(W - M - 22, ty, '$4,800')

y -= box_h + 32

# ---------- what it does ----------
c.setFont(SERIF_B, 15)
c.setFillColorRGB(*INK)
c.drawString(M, y, 'What Dawnpipe does')
y -= 22

items = [
    ('Answers every call.',
     'Days, nights, weekends, holidays. It never puts anyone on hold and it never misses one.'),
    ('Books the job into your calendar.',
     'It takes the name, the number and the problem, then books the slot and texts them a confirmation.'),
    ('Tells you what happened.',
     'Every call transcribed and waiting for you, so nothing is lost because you were busy working.'),
]
for head, body in items:
    c.setFillColorRGB(*RED)
    c.circle(M + 4, y + 3.5, 3, stroke=0, fill=1)
    c.setFont(SERIF_B, 11.5)
    c.setFillColorRGB(*INK)
    c.drawString(M + 16, y, head)
    y -= 15
    y = text(M + 16, y, body, size=10.8, leading=14, width=W - 2 * M - 16)
    y -= 8

# ---------- the demo ----------
y -= 6
demo_h = 74
c.setFillColorRGB(*INK)
c.roundRect(M, y - demo_h, W - 2 * M, demo_h, 8, stroke=0, fill=1)

c.setFont(SERIF_B, 13.5)
c.setFillColorRGB(*PAPER)
c.drawString(M + 22, y - 27, 'Do not take our word for it. Call it right now.')
c.setFont(SERIF, 10.8)
c.drawString(M + 22, y - 44, 'Say your water heater is leaking. You are talking to the exact thing you would be buying.')
c.setFont(SERIF_B, 20)
c.setFillColorRGB(0.98, 0.85, 0.52)
c.drawString(M + 22, y - 66, '(213) 682-2616')

y -= demo_h + 30

# ---------- price ----------
c.setFont(SERIF_B, 15)
c.setFillColorRGB(*INK)
c.drawString(M, y, 'What it costs')
y -= 24

col = W - M - 150
rows = [
    ('A receptionist, 9 to 5', '$3,000 / mo', False),
    ('Dawnpipe, around the clock', '$399 / mo', True),
]
for label, price, hero in rows:
    c.setFont(SERIF_B if hero else SERIF, 12 if hero else 11.5)
    c.setFillColorRGB(*(INK if hero else INK2))
    c.drawString(M, y, label)
    c.setFont(SERIF_B, 13 if hero else 11.5)
    c.setFillColorRGB(*(RED if hero else INK2))
    c.drawRightString(W - M, y, price)
    y -= 10
    c.setStrokeColorRGB(*LINE)
    c.setLineWidth(0.8)
    c.line(M, y, W - M, y)
    y -= 16

y -= 2
y = text(M, y, 'No payroll tax, no workers comp, no holiday cover, no notice period. It does not call in sick '
                'and it does not quit. Month to month, no contract, cancel in one click  —  it runs to the end '
                'of the month you have paid for, then stops.',
         size=10.5, leading=14, width=W - 2 * M)

# ---------- footer ----------
c.setStrokeColorRGB(*INK)
c.setLineWidth(1.6)
c.line(M, 52, W - M, 52)
c.setFont(SERIF_B, 11)
c.setFillColorRGB(*INK)
c.drawString(M, 36, 'dawnpipe.com')
c.setFont(SERIF, 10)
c.setFillColorRGB(*INK2)
c.drawRightString(W - M, 36, 'Built for the trades  ·  plumbing, HVAC, roofing, electrical and anyone who books work')
c.setFont(SERIF, 7.5)
c.setFillColorRGB(0.62, 0.60, 0.56)
c.drawString(M, 24, STAMP)

c.showPage()
c.save()
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
