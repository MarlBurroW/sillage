{{/* Nom court, surchargeable. */}}
{{- define "sillage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Nom complet des ressources : <release>-<chart>, sans doublon si la release
     porte déjà le nom du chart. 63 caractères est la limite d'un label. */}}
{{- define "sillage.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "sillage.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sillage.labels" -}}
helm.sh/chart: {{ include "sillage.chart" . }}
{{ include "sillage.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Ces labels forment le selector du Deployment : il est immuable, donc rien
     de variable (version, tag) ne doit y figurer. */}}
{{- define "sillage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sillage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Nom du PVC d'un volume : celui fourni par l'utilisateur, sinon le nôtre. */}}
{{- define "sillage.claimName" -}}
{{- $ctx := .ctx -}}
{{- $vol := .vol -}}
{{- $cfg := index $ctx.Values.storage $vol -}}
{{- if $cfg.existingClaim -}}
{{- $cfg.existingClaim -}}
{{- else -}}
{{- printf "%s-%s" (include "sillage.fullname" $ctx) $vol -}}
{{- end -}}
{{- end -}}
