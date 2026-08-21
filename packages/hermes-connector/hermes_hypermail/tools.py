"""Hermes model tools for explicit durable-task terminal reporting.

Assistant prose is intentionally not observed here. A task changes state only
when the model invokes one of these structured tools.
"""
from __future__ import annotations

import json
import threading
from typing import Any

from .client import Claim, HypermailConnectorClient

_ALLOWED_FAILURES = {
    "MANAGER_UNAVAILABLE", "RATE_LIMITED", "DEPENDENCY_UNAVAILABLE", "LEASE_EXPIRED",
    "DEADLINE_EXCEEDED", "INVALID_REPORT", "AUTHORIZATION_REVOKED", "OWNER_CANCELLED", "INTERNAL",
}


class TaskRuntime:
    def __init__(self, client: HypermailConnectorClient):
        self.client = client
        self._claims: dict[str, Claim] = {}
        self._lock = threading.Lock()
        self.changed = threading.Event()

    def activate(self, claim: Claim) -> None:
        with self._lock:
            if claim.task_id in self._claims:
                raise RuntimeError("Task is already active.")
            self._claims[claim.task_id] = claim
            self.changed.set()

    def is_active(self, task_id: str) -> bool:
        with self._lock:
            return task_id in self._claims

    def complete(self, task_id: str, result: dict[str, Any]) -> None:
        with self._lock:
            claim = self._claims.get(task_id)
            if claim is None:
                raise ValueError("No active Hypermail task has that task_id.")
            # Keep the claim registered until the fenced report is accepted.
            self.client.complete(claim, result)
            del self._claims[task_id]
            self.changed.set()

    def fail(self, task_id: str, error_code: str) -> None:
        with self._lock:
            claim = self._claims.get(task_id)
            if claim is None:
                raise ValueError("No active Hypermail task has that task_id.")
            self.client.fail(claim, error_code)
            del self._claims[task_id]
            self.changed.set()


_RUNTIMES: list[TaskRuntime] = []
_RUNTIME_LOCK = threading.Lock()


def add_runtime(runtime: TaskRuntime) -> None:
    with _RUNTIME_LOCK:
        if runtime not in _RUNTIMES:
            _RUNTIMES.append(runtime)


def remove_runtime(runtime: TaskRuntime) -> None:
    with _RUNTIME_LOCK:
        if runtime in _RUNTIMES:
            _RUNTIMES.remove(runtime)


def _runtime(task_id: str) -> TaskRuntime:
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("task_id is required.")
    with _RUNTIME_LOCK:
        matches = [runtime for runtime in _RUNTIMES if runtime.is_active(task_id)]
    if len(matches) != 1:
        raise ValueError("task_id does not identify exactly one active Hypermail task.")
    return matches[0]


def _ok(kind: str) -> str:
    return json.dumps({"success": True, "reported": kind}, separators=(",", ":"))


def task_no_action(args: dict[str, Any], **_: Any) -> str:
    task_id = args.get("task_id")
    _runtime(task_id).complete(task_id, {"kind": "no_action"})
    return _ok("no_action")


def task_question(args: dict[str, Any], **_: Any) -> str:
    task_id, question_id = args.get("task_id"), args.get("question_id")
    if not isinstance(question_id, str) or not question_id:
        raise ValueError("question_id from the structured question-creation tool is required.")
    _runtime(task_id).complete(task_id, {"kind": "question", "questionId": question_id})
    return _ok("question")


def task_actions(args: dict[str, Any], **_: Any) -> str:
    task_id, action_ids = args.get("task_id"), args.get("action_ids")
    if not isinstance(action_ids, list) or not action_ids or len(action_ids) > 20 or any(not isinstance(v, str) or not v for v in action_ids) or len(set(action_ids)) != len(action_ids):
        raise ValueError("action_ids must contain 1-20 unique structured action IDs.")
    _runtime(task_id).complete(task_id, {"kind": "action_requests_emitted", "actionIds": action_ids})
    return _ok("action_requests_emitted")


def task_failure(args: dict[str, Any], **_: Any) -> str:
    task_id, error_code = args.get("task_id"), args.get("error_code")
    if error_code not in _ALLOWED_FAILURES:
        raise ValueError("Unsupported durable task failure code.")
    _runtime(task_id).fail(task_id, error_code)
    return _ok("failure")


def _schema(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"name": name, "description": description, "parameters": {
        "type": "object", "additionalProperties": False, "properties": properties, "required": required,
    }}


def register_tools(ctx: Any) -> None:
    task_id = {"type": "string", "description": "Exact active task_id from the Hypermail task envelope."}
    entries = [
        ("hypermail_task_no_action", "Explicitly complete a Hypermail task that needs no action. Never use prose as completion.",
         {"task_id": task_id}, ["task_id"], task_no_action),
        ("hypermail_task_question", "Complete by referencing a question created through the structured Hypermail question tool.",
         {"task_id": task_id, "question_id": {"type": "string"}}, ["task_id", "question_id"], task_question),
        ("hypermail_task_actions", "Complete by referencing structured action request IDs already emitted by Hypermail tools.",
         {"task_id": task_id, "action_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 20, "uniqueItems": True}},
         ["task_id", "action_ids"], task_actions),
        ("hypermail_task_failure", "Report a typed retryable or terminal failure for the active task.",
         {"task_id": task_id, "error_code": {"type": "string", "enum": sorted(_ALLOWED_FAILURES)}}, ["task_id", "error_code"], task_failure),
    ]
    for name, description, properties, required, handler in entries:
        ctx.register_tool(name=name, toolset="hypermail", schema=_schema(name, description, properties, required), handler=handler)
