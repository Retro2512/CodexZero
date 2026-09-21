param([string]$InputPath = (Join-Path $PSScriptRoot '..\assets\codexzero.png'), [string]$OutputPath = (Join-Path $PSScriptRoot '..\assets\codexzero.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [Drawing.Bitmap]::FromFile([IO.Path]::GetFullPath($InputPath))
$frames = [Collections.Generic.List[byte[]]]::new()
$sizes = @(16,24,32,48,64,128,256)
try {
 foreach ($size in $sizes) {
  $bitmap = [Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $stream = [IO.MemoryStream]::new()
  try {
   $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
   $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
   $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
   $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
   $graphics.DrawImage($source,0,0,$size,$size)
   $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
   $frames.Add($stream.ToArray())
  } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
 }
 $file = [IO.File]::Create([IO.Path]::GetFullPath($OutputPath)); $writer=[IO.BinaryWriter]::new($file)
 try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
  $offset=6+16*$sizes.Count
  for($i=0;$i -lt $sizes.Count;$i++) {
   $dimension=if($sizes[$i] -eq 256){0}else{$sizes[$i]}
   $writer.Write([byte]$dimension);$writer.Write([byte]$dimension);$writer.Write([byte]0);$writer.Write([byte]0)
   $writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$frames[$i].Length);$writer.Write([uint32]$offset)
   $offset += $frames[$i].Length
  }
  foreach($frame in $frames){$writer.Write($frame)}
 }finally{$writer.Dispose();$file.Dispose()}
 Write-Output "Created icon with $($sizes.Count) sizes"
}finally{$source.Dispose()}
