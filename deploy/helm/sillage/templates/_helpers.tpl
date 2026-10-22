{{/* Short name, overridable. */}}
{{- define "sillage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Full resource name: <release>-<chart>, without duplication when release
     already contains chart name. Labels are limited to 63 characters. */}}
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

{{/* These labels form the immutable Deployment selector: no changing values
     (version, tag) may appear here. */}}
{{- define "sillage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sillage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Volume PVC name: user-supplied name or ours. */}}
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
