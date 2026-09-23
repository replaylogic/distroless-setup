"""Views for the Django integration fixture.

`health` reports the uid/gid the process really runs as, the same contract the
other integration fixtures use, plus the hashed URL WhiteNoise resolved for a
collected static file — which is only possible if `collectstatic` ran at build
time and wrote a manifest into the image.
"""

import os

from django.http import HttpResponse, JsonResponse
from django.templatetags.static import static


def health(_request) -> JsonResponse:
    try:
        static_url = static("fixture.css")
    except ValueError as exc:  # no manifest entry: collectstatic did not run
        static_url = f"unresolved: {exc}"
    return JsonResponse(
        {
            "status": "ok",
            "uid": os.getuid(),
            "gid": os.getgid(),
            "greeting": os.environ.get("GREETING", "default-greeting"),
            "server": "gunicorn-wsgi",
            "framework": "django",
            "settingsModule": os.environ.get("DJANGO_SETTINGS_MODULE", ""),
            "staticUrl": static_url,
        }
    )


def index(_request) -> HttpResponse:
    return HttpResponse("fixture-django-uv\n", content_type="text/plain")
