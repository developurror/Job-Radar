"""Learned-match model (Phase 6): a logistic regression over job embeddings,
trained statelessly on the user's local thumbs up/down labels.

The model is refit per request from the labels the API sends — nothing is
persisted here and no state survives the call.
"""
from __future__ import annotations

MIN_TOTAL_LABELS = 20
MIN_PER_CLASS_LABELS = 5


def score_targets(examples, targets, embed_function):
    """Score target texts by resemblance to the labeled examples.

    examples: list of {text, label} — only 'up' (positive) and 'down'
    (negative) labels count; any other label is ignored entirely.
    targets: list of {id, text}.
    embed_function(texts) -> vectors.

    Returns {modelReady, labelCount, positiveCount, negativeCount,
    scores: [{id, probability}]} where probability is an int 0..100.
    The model is only ready with at least MIN_TOTAL_LABELS labels and at
    least MIN_PER_CLASS_LABELS of each class; otherwise scores is empty.
    """
    labeled_examples = [
        example for example in examples if example["label"] in ("up", "down")
    ]
    positive_count = sum(
        1 for example in labeled_examples if example["label"] == "up"
    )
    negative_count = len(labeled_examples) - positive_count
    label_count = len(labeled_examples)

    model_ready = (
        label_count >= MIN_TOTAL_LABELS
        and positive_count >= MIN_PER_CLASS_LABELS
        and negative_count >= MIN_PER_CLASS_LABELS
    )
    result = {
        "modelReady": model_ready,
        "labelCount": label_count,
        "positiveCount": positive_count,
        "negativeCount": negative_count,
        "scores": [],
    }
    if not model_ready or not targets:
        return result

    from sklearn.linear_model import LogisticRegression

    example_texts = [example["text"] for example in labeled_examples]
    target_texts = [target["text"] for target in targets]
    all_vectors = embed_function(example_texts + target_texts)
    example_vectors = all_vectors[: len(example_texts)]
    target_vectors = all_vectors[len(example_texts) :]

    labels = [1 if example["label"] == "up" else 0 for example in labeled_examples]
    model = LogisticRegression(max_iter=1000)
    model.fit(example_vectors, labels)
    positive_class_index = list(model.classes_).index(1)
    target_probabilities = model.predict_proba(target_vectors)

    scores = []
    for target, probabilities in zip(targets, target_probabilities):
        probability = int(round(100 * float(probabilities[positive_class_index])))
        scores.append(
            {"id": target["id"], "probability": max(0, min(100, probability))}
        )
    result["scores"] = scores
    return result
