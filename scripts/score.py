#!/usr/bin/env python3
"""Venom's local scorer.

Reads one JSON object per line on stdin ({"text": "..."}) and writes one
ScoredItem per line on stdout, in the same order. Nothing is written to disk
and nothing leaves this machine.

  python3 -m pip install "transformers>=4.44" torch --index-url \
      https://download.pytorch.org/whl/cpu
  echo '{"text":"still no water in ward 42, third day"}' | python3 scripts/score.py

The default model was fine-tuned on eight languages, none of them South
African. It is a starting point, not a finished answer - see the note in
src/nlp/local.ts and treat non-English wards as under-measured.

Category assignment here is the same lexicon the TypeScript baseline uses,
because the sentiment models on the shelf classify polarity, not which
municipal service a complaint is about. That half of the problem wants a
classifier fine-tuned on local complaint data; until there is one, keep the
two halves visibly separate rather than pretending the model did both.
"""

from __future__ import annotations

import argparse
import json
import sys

CATEGORY_TERMS = {
    "Electricity": ["load shedding", "loadshedding", "eskom", "city power", "power cut",
                    "power outage", "no power", "no electricity", "blackout", "transformer",
                    "cable theft", "substation"],
    "Water": ["no water", "water outage", "water cut", "rand water", "joburg water",
              "burst pipe", "water leak", "water tanker", "dry taps", "reservoir"],
    "Sanitation": ["sewage", "sewer", "drain", "manhole", "effluent", "toilet",
                   "waste water", "spillage", "overflow"],
    "Refuse": ["refuse", "rubbish", "bins", "pikitup", "illegal dumping", "dumping",
               "waste collection", "uncollected", "landfill", "litter"],
    "Roads": ["pothole", "potholes", "road closed", "robots not working", "traffic light",
              "street light", "streetlight", "gravel road", "tarring"],
    "Housing": ["rdp", "housing list", "title deed", "informal settlement", "shack",
                "backyard", "eviction", "hostel", "waiting list"],
    "Safety": ["crime", "hijack", "robbery", "shooting", "gang", "cpf", "police station",
               "patrol", "break-in", "mugging", "zama zama"],
    "Health": ["clinic", "hospital", "medicine", "ambulance", "nurse", "chronic meds"],
    "Transport": ["taxi", "bus", "rea vaya", "gautrain", "metrobus", "putco", "prasa",
                  "commute", "fare"],
    "Billing": ["municipal bill", "billing", "overcharged", "meter reading", "prepaid meter",
                "arrears", "disconnection", "rates and taxes", "account statement"],
}

MOBILISING = ["protest", "march", "shutdown", "picket", "memorandum", "petition",
              "join us", "mass action", "vote them out", "community meeting",
              "enough is enough"]
ANGRY = ["disgusting", "disgrace", "fed up", "sick and tired", "useless", "corrupt",
         "thieves", "pathetic", "unacceptable", "outrageous", "shameful", "incompetent"]
RESIGNED = ["as usual", "nothing new", "same old", "no point", "gave up", "given up",
            "nobody cares", "typical", "used to it", "never going to change"]


def categorise(text: str) -> str:
    low = text.lower()
    best, best_hits = "Other", 0
    for category, terms in CATEGORY_TERMS.items():
        hits = sum(1 for t in terms if t in low)
        if hits > best_hits:
            best, best_hits = category, hits
    return best


def tone_for(text: str, polarity: float) -> str:
    low = text.lower()
    # Mobilising first: an angry post that also calls a march is operationally
    # a mobilising post.
    if any(t in low for t in MOBILISING):
        return "Mobilising"
    if any(t in low for t in ANGRY):
        return "Angry"
    if any(t in low for t in RESIGNED):
        return "Resigned"
    return "Resigned" if polarity > 0.2 else "Frustrated"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="cardiffnlp/twitter-xlm-roberta-base-sentiment")
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()

    try:
        from transformers import pipeline
    except ImportError:
        print("transformers is not installed; see the header of this file",
              file=sys.stderr)
        return 2

    items = [json.loads(line) for line in sys.stdin if line.strip()]
    if not items:
        return 0

    texts = [i["text"] for i in items]
    classifier = pipeline("sentiment-analysis", model=args.model, truncation=True)
    results = classifier(texts, batch_size=args.batch_size)

    for text, result in zip(texts, results):
        label = str(result["label"]).lower()
        score = float(result["score"])
        # Map whatever the model calls its classes onto one signed number.
        # A neutral verdict is not zero-with-certainty: it is a weak reading,
        # so it carries the model's own confidence downward rather than
        # asserting the middle.
        if "neg" in label or label in {"label_0", "1 star", "2 stars"}:
            polarity = -score
        elif "pos" in label or label in {"label_2", "4 stars", "5 stars"}:
            polarity = score
        else:
            polarity = 0.0

        print(json.dumps({
            "category": categorise(text),
            "polarity": round(polarity, 3),
            "tone": tone_for(text, polarity),
            # The model is confident about polarity; the category came from a
            # word list. Report the weaker of the two, not the stronger.
            "confidence": round(min(score, 0.75), 3),
        }), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
