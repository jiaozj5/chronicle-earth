param([string]$ImagePath,[switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($Check) { @{available=($null -ne $engine);languages=@([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {$_.LanguageTag})} | ConvertTo-Json -Compress; exit }
$taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-WinRT($Operation,$Type) { $task = $taskMethod.MakeGenericMethod($Type).Invoke($null,@($Operation)); $task.GetAwaiter().GetResult() }
$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
if ($null -eq $engine) { throw 'Windows OCR language pack unavailable' }
$result = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @($result.Lines | ForEach-Object {
    $words = @($_.Words)
    $left=($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
    $top=($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
    $right=($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
    $bottom=($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
    $mappedWords=@($words | ForEach-Object { @{text=$_.Text;rect=@(($_.BoundingRect.X/$bitmap.PixelWidth),($_.BoundingRect.Y/$bitmap.PixelHeight),($_.BoundingRect.Width/$bitmap.PixelWidth),($_.BoundingRect.Height/$bitmap.PixelHeight))} })
    @{text=$_.Text;rect=@(($left/$bitmap.PixelWidth),($top/$bitmap.PixelHeight),(($right-$left)/$bitmap.PixelWidth),(($bottom-$top)/$bitmap.PixelHeight));words=$mappedWords}
})
@{lines=$lines;language=$engine.RecognizerLanguage.LanguageTag} | ConvertTo-Json -Depth 6 -Compress
$bitmap.Dispose();$stream.Dispose()
