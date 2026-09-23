from django.urls import path

from health.views import health, index

urlpatterns = [
    path("health/", health, name="health"),
    path("", index, name="index"),
]
