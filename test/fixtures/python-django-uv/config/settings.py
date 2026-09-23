"""Settings for the Django integration fixture.

Deliberately minimal: no database is configured, because nothing in this fixture
reads or writes one. That keeps the container test honest — it proves the
distroless runtime, `collectstatic` and static serving, not a database driver.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Build-time commands such as `collectstatic` must not need real secrets.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "build-only-insecure-key")
DEBUG = False
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",")

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "health",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # WhiteNoise serves the files `collectstatic` gathers, straight from the image.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    },
]

# No database: this fixture never touches one, so a read-only root needs no volume.
DATABASES: dict = {}

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    # Hashes and compresses at collectstatic time, i.e. during `docker build`,
    # so nothing has to be written at runtime.
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
