# -*- coding: utf-8 -*-
"""Dawnpipe cold-call script. Written to be used live: the words to say are in
dark serif, the coaching around them is small and grey, so a rep can find their
line at a glance while someone is talking to them."""
import os
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Dawnpipe-Cold-Call-Script.pdf')

PAPER = (0.957, 0.945, 0.918)
INK   = (0.102, 0.094, 0.082)
INK2  = (0.290, 0.275, 0.247)
RED   = (0.753, 0.165, 0.106)
LINE  = (0.851, 0.827, 0.776)
WHITE = (1, 1, 1)

W, H = LETTER
M = 52
SERIF, SERIF_B, SERIF_I = 'Times-Roman', 'Times-Bold', 'Times-Italic'

c = canvas.Canvas(OUT, pagesize=LETTER)
c.setTitle('Dawnpipe — cold call script')
c.setAuthor('Dawnpipe')

state = {'y': 0}


def new_page(title=None):
    c.setFillColorRGB(*PAPER)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColorRGB(*RED)
    c.rect(0, H - 9, W, 9, stroke=0, fill=1)
    y = H - 56
    c.setFont(SERIF_B, 20)
    c.setFillColorRGB(*INK)
    c.drawString(M, y, 'Dawn')
    wm = c.stringWidth('Dawn', SERIF_B, 20)
    c.setFillColorRGB(*RED)
    c.drawString(M + wm, y, 'pipe')
    if title:
        c.setFont(SERIF, 10.5)
        c.setFillColorRGB(*INK2)
        c.drawRightString(W - M, y, title)
    y -= 18
    c.setStrokeColorRGB(*INK)
    c.setLineWidth(1.4)
    c.line(M, y, W - M, y)
    state['y'] = y - 30


def room(need):
    """Start a new page if `need` points of vertical space aren't left."""
    if state['y'] - need < 60:
        c.showPage()
        new_page('cold call script')


def para(s, font=SERIF, size=10.4, color=INK2, lead=13.6, indent=0, gap=6):
    room(40)
    c.setFont(font, size)
    c.setFillColorRGB(*color)
    for ln in simpleSplit(s, font, size, W - 2 * M - indent):
        room(lead + 4)
        c.setFont(font, size)
        c.setFillColorRGB(*color)
        c.drawString(M + indent, state['y'], ln)
        state['y'] -= lead
    state['y'] -= gap


def heading(n, s):
    room(50)
    c.setFont(SERIF_B, 14.5)
    c.setFillColorRGB(*RED)
    c.drawString(M, state['y'], n)
    c.setFillColorRGB(*INK)
    c.drawString(M + c.stringWidth(n + '  ', SERIF_B, 14.5), state['y'], s)
    state['y'] -= 20


def say(s):
    """A line to actually speak. Red bar + dark serif so it stands out live."""
    lines = simpleSplit(s, SERIF, 11.6, W - 2 * M - 34)
    h = len(lines) * 15.5 + 14
    room(h + 10)
    top = state['y'] + 11
    c.setFillColorRGB(*WHITE)
    c.setStrokeColorRGB(*LINE)
    c.setLineWidth(0.8)
    c.roundRect(M, top - h, W - 2 * M, h, 5, stroke=1, fill=1)
    c.setFillColorRGB(*RED)
    c.rect(M, top - h, 3.5, h, stroke=0, fill=1)
    ty = top - 18
    c.setFont(SERIF, 11.6)
    c.setFillColorRGB(*INK)
    for ln in lines:
        c.drawString(M + 18, ty, ln)
        ty -= 15.5
    state['y'] = top - h - 12


def note(s):
    para(s, font=SERIF_I, size=9.8, color=INK2, lead=12.6, indent=4, gap=10)


def qa(q, a):
    room(46)
    c.setFont(SERIF_B, 10.8)
    c.setFillColorRGB(*INK)
    for ln in simpleSplit('“' + q + '”', SERIF_B, 10.8, W - 2 * M):
        room(14)
        c.setFont(SERIF_B, 10.8)
        c.setFillColorRGB(*INK)
        c.drawString(M, state['y'], ln)
        state['y'] -= 13.6
    state['y'] -= 1
    para(a, size=10.2, lead=13, indent=14, gap=11)


# ================= page 1 =================
new_page('cold call script')

c.setFont(SERIF_B, 22)
c.setFillColorRGB(*INK)
c.drawString(M, state['y'], 'Cold call script')
state['y'] -= 24
para('Who to call: plumbing, HVAC, roofing, electrical, garage doors, water damage and restoration, '
     'towing, pest control. Owner-operator up to about twenty staff. If someone answers the phone on '
     'the first ring every time, they are not your customer.', size=10.6, lead=14, gap=16)

heading('1.', 'Open honestly. Do not pretend to be a customer.')
say('Hi, is this the owner? — My name is ____, I know this is a cold call, can I have thirty seconds and '
    'then you can tell me to get lost?')
note('Almost everyone says yes to thirty seconds. Pretending to need a quote gets you a real conversation '
     'and then a furious one. Never do it.')

heading('2.', 'Two questions. These do the selling, not you.')
say('How many calls would you say you miss in a week? — when you are up a ladder or on a job.')
say('And roughly what is one job worth to you?')
note('Then say the multiplication out loud, slowly, and stop talking. Three calls at four hundred dollars '
     'is about five thousand a month. Their number, their mouth, their problem. Silence here is the most '
     'powerful thing on the call.')

heading('3.', 'Hand them the demo. Do not describe the product.')
say('Do not take my word for any of this. Hang up on me, call 213-682-2616, and tell it your water heater '
    'is leaking. That is the thing I am selling. Call me back if it is any good.')
note('This wins more deals than anything you can say. They experience it instead of trusting you. Most '
     'people will not hang up — they will put you on speaker and call it while you wait.')

heading('4.', 'Price it against a person, never against software.')
say('A receptionist is three grand a month and goes home at five. This is three hundred and ninety nine, '
    'and it works nights and weekends. It does not call in sick and it does not quit.')

# ================= page 2 =================
c.showPage()
new_page('cold call script')

c.setFont(SERIF_B, 17)
c.setFillColorRGB(*INK)
c.drawString(M, state['y'], 'The five objections you will hear')
state['y'] -= 24

qa('My customers will hate talking to a robot.',
   'They hate voicemail more, and voicemail is what they get today. It also says it is an AI in the first '
   'sentence, so nobody feels tricked. Ask them: would you rather a machine that books the job, or a '
   'voicemail nobody listens to?')
qa('I answer my own phone.',
   'Agree with them, then aim at the gap. Of course you do — when you can reach it. I am talking about the '
   'ones that come in while you are under a sink with the water off.')
qa('Too expensive.',
   'Answer with their own number from question two. It is less than one job. If it books you one job a '
   'month it has paid for itself twice over — and there is no contract, so if it does not, you cancel and '
   'that is the end of it.')
qa('What if it says the wrong price?',
   'It can only say prices you typed in. If you have not given it a number it says it does not have pricing '
   'and offers a callback. It physically cannot invent one.')
qa('Send me some information.',
   'Usually a soft no. Take the demo instead: I can, but it will tell you less than ninety seconds on the '
   'phone with it. Call 213-682-2616 tonight, and I will call you Thursday morning either way.')

state['y'] -= 4
heading('5.', 'Close on a small, specific next step.')
say('Let us just switch it on for a month. You keep your own number, it answers what you miss, and at the '
    'end you look at what it booked. If it booked you nothing, cancel it — there is no contract to get out of.')
note('Never close on "think it over". Close on a date and a time you will call back. And do not promise a '
     'refund or a free trial — we do not offer one. What we offer is no contract and no lock-in, which is '
     'a real answer to the risk objection without you writing a check you cannot cash.')

state['y'] -= 2
heading('6.', 'Voicemail — keep it under fifteen seconds.')
say('Hi, it is ____ . I have got something that answers the calls you miss when you are on a job. Do not '
    'call me back — call 213-682-2616 and hear it yourself, then decide. I will try you Thursday.')

state['y'] -= 6
box_top = state['y']
lines_txt = [
    ('Do not say it pays for itself because it is a tax write-off.',
     'It is deductible like any software, but a deduction is not a refund — at a quarter rate, $399 really '
     'costs about $300. Any owner with an accountant will catch that and stop believing everything else you '
     'said. The honest version is stronger anyway: no payroll tax, no workers comp, no holiday cover, no '
     'notice period. Say that instead, and add "your accountant will confirm it is deductible."'),
]
for head, body in lines_txt:
    hl = simpleSplit(body, SERIF, 10, W - 2 * M - 36)
    bh = 30 + len(hl) * 13.4
    c.setFillColorRGB(0.988, 0.914, 0.906)
    c.setStrokeColorRGB(0.902, 0.690, 0.659)
    c.setLineWidth(0.9)
    c.roundRect(M, box_top - bh, W - 2 * M, bh, 6, stroke=1, fill=1)
    c.setFont(SERIF_B, 11)
    c.setFillColorRGB(0.627, 0.149, 0.090)
    c.drawString(M + 16, box_top - 20, head)
    ty = box_top - 36
    c.setFont(SERIF, 10)
    c.setFillColorRGB(*INK2)
    for ln in hl:
        c.drawString(M + 16, ty, ln)
        ty -= 13.4
    state['y'] = box_top - bh - 16

c.setStrokeColorRGB(*INK)
c.setLineWidth(1.4)
c.line(M, 50, W - M, 50)
c.setFont(SERIF_B, 10.5)
c.setFillColorRGB(*INK)
c.drawString(M, 35, 'dawnpipe.com')
c.setFont(SERIF, 9.6)
c.setFillColorRGB(*INK2)
c.drawRightString(W - M, 35, 'Demo line, always on  ·  (213) 682-2616')

c.showPage()
c.save()
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
