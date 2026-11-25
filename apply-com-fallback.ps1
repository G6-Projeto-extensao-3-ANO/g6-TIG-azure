# Executa o terraform apply tentando vários tamanhos de VM, na ordem,
# até um deles funcionar. Só avança para o próximo tamanho quando o erro
# for de capacidade/SKU/cota; qualquer outro erro interrompe o script.
#
# Lista padrão do Worker (TIG): prioriza 2 vCPUs / 8 GiB, do mais barato ao mais caro.
# Os dois últimos têm só 4 GiB (último recurso para InfluxDB + Grafana + Node-RED).
#
# Uso (na pasta do Terraform):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\apply-com-fallback.ps1
#   .\apply-com-fallback.ps1 -Sizes "Standard_B2s_v2","Standard_D2s_v5"

param(
    [string[]]$Sizes = @(
        "Standard_B2as_v2",   # 2 vCPU / 8 GiB (tamanho atual)
        "Standard_B2s_v2",    # 2 vCPU / 8 GiB
        "Standard_D2as_v5",   # 2 vCPU / 8 GiB
        "Standard_D2s_v5",    # 2 vCPU / 8 GiB
        "Standard_D2s_v3",    # 2 vCPU / 8 GiB
        "Standard_B2s",       # 2 vCPU / 4 GiB (último recurso)
        "Standard_B2ls_v2"    # 2 vCPU / 4 GiB (último recurso)
    )
)

# Erros que justificam tentar outro tamanho
$padraoIndisponivel = "SkuNotAvailable|Capacity Restrictions|NotAvailableForSubscription|OverconstrainedAllocationRequest|OverconstrainedZonalAllocationRequest|ZonalAllocationFailed|AllocationFailed|QuotaExceeded|exceeding approved"

foreach ($size in $Sizes) {
    Write-Host ""
    Write-Host "=== Tentando o Worker com $size ===" -ForegroundColor Cyan

    terraform apply -auto-approve -no-color -var="vm_size=$size" 2>&1 | Tee-Object -Variable saida

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Sucesso com $size" -ForegroundColor Green
        Write-Host "Dica: ajuste o default de vm_size em variables.tf para $size, senão um apply comum tentará voltar ao tamanho antigo." -ForegroundColor Yellow
        exit 0
    }

    $textoErro = $saida -join "`n"
    if ($textoErro -match $padraoIndisponivel) {
        Write-Warning "$size indisponível (capacidade/cota). Tentando o próximo..."
        continue
    }

    Write-Host ""
    Write-Host "Erro que não é de indisponibilidade de SKU. Interrompendo." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Nenhum dos tamanhos informados está disponível." -ForegroundColor Red
exit 1
