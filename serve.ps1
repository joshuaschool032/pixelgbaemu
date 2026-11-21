param(
  [ValidateRange(1, 65535)] [int] $Port = 8080
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootPrefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$Prefix = "http://127.0.0.1:$Port/"
$Types = @{
  ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8";
  ".css"="text/css; charset=utf-8"; ".json"="application/json; charset=utf-8";
  ".wasm"="application/wasm"; ".data"="application/octet-stream";
  ".txt"="text/plain; charset=utf-8"; ".md"="text/markdown; charset=utf-8"
}
$Listener = [Net.HttpListener]::new()
$Listener.Prefixes.Add($Prefix)
$Listener.Start()
Write-Host "PixelGBA: $Prefix"
try {
  while ($Listener.IsListening) {
    $Context = $Listener.GetContext()
    try {
      $Relative = [Uri]::UnescapeDataString($Context.Request.Url.AbsolutePath.TrimStart('/'))
      if (-not $Relative) { $Relative = "index.html" }
      $File = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
      if (-not $File.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($File)) {
        $Context.Response.StatusCode = 404
      } elseif ($Context.Request.HttpMethod -notin @("GET", "HEAD")) {
        $Context.Response.StatusCode = 405
      } else {
        $Bytes = [IO.File]::ReadAllBytes($File)
        $Ext = [IO.Path]::GetExtension($File).ToLowerInvariant()
        $Context.Response.ContentType = $(if ($Types[$Ext]) { $Types[$Ext] } else { "application/octet-stream" })
        $Context.Response.ContentLength64 = $Bytes.Length
        $Context.Response.Headers.Add("Cache-Control", "no-cache")
        $Context.Response.Headers.Add("X-Content-Type-Options", "nosniff")
        if ($Context.Request.HttpMethod -ne "HEAD") { $Context.Response.OutputStream.Write($Bytes, 0, $Bytes.Length) }
      }
    } catch { $Context.Response.StatusCode = 500 }
    finally { $Context.Response.Close() }
  }
} finally { $Listener.Stop(); $Listener.Close() }
