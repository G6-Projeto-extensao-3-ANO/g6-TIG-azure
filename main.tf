terraform {
  required_version = ">= 1.0.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

# 1. Busca as variáveis de rede criada separadamente:
data "terraform_remote_state" "rede" {
  backend = "local"

  config = {
    path = "../g6-network-azure/terraform.tfstate"
  }
}

# 2. Conectando na SUB-Rede criada anteriormente:
resource "azurerm_network_interface" "nic_worker" {
  name                = "worker84"
  location            = data.terraform_remote_state.rede.outputs.location
  resource_group_name = data.terraform_remote_state.rede.outputs.resource_group_name

  ip_configuration {
    name                          = "configuracao-ip-worker"
    subnet_id                     = data.terraform_remote_state.rede.outputs.subnet_publica_id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = data.terraform_remote_state.rede.outputs.public_ip_id
  }
}

# 3. Aqui fica a VM:
resource "azurerm_linux_virtual_machine" "vm_worker" {
  name                  = "Worker"
  resource_group_name   = data.terraform_remote_state.rede.outputs.resource_group_name
  location              = data.terraform_remote_state.rede.outputs.location
  size                  = var.vm_size # padrão: Standard_B2as_v2 (2 vCPUs, 8 GiB RAM)
  admin_username        = "azureuser"
  zone                  = "1"
  network_interface_ids = [azurerm_network_interface.nic_worker.id]

  admin_ssh_key {
    username   = "azureuser"
    public_key = local.ssh_public_key
  }

  os_disk {
    name                 = "osdisk-worker"
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts"
    version   = "latest"
  }

  tags = {
    environment = "producao"
  }
}

# 4. Script que instala o Docker, grava os arquivos da pasta e sobe a Stack TIG + Grafana + Node-RED
#
# Estrutura esperada ao lado deste main.tf:
#   docker-compose.yml
#   nginx.conf
#   telegraf.conf
#   grafana/dashboards/iotrace.json
#   grafana/provisioning/dashboards/dashboards.yml
#   grafana/provisioning/datasources/influxdb.yml
#
# Observações:
#  - Os arquivos de texto passam por replace() para remover CRLF (Windows) e evitar
#    problemas em YAML/TOML/nginx dentro do Linux.
#  - O iotrace.json (~420 KB) é comprimido com base64gzip: o script da extensão
#    CustomScript tem limite de 256 KB e, sem compressão, estouraria.
#  - Para o Grafana redirecionar corretamente após o login (root_url), o script
#    descobre o IP público pelo serviço de metadados do Azure e grava no .env.
locals {
  setup_script = <<-EOT
    #!/bin/bash
    set -e
    export DEBIAN_FRONTEND=noninteractive

    apt-get update -y
    apt-get install -y docker.io docker-compose-v2 curl
    systemctl enable --now docker
    usermod -aG docker azureuser

    APP=/home/azureuser/app
    mkdir -p $APP/nginx $APP/telegraf \
             $APP/grafana/dashboards \
             $APP/grafana/provisioning/dashboards \
             $APP/grafana/provisioning/datasources

    echo '${base64encode(replace(file("${path.module}/docker-compose.yml"), "\r", ""))}' | base64 -d > $APP/docker-compose.yml
    echo '${base64encode(replace(file("${path.module}/nginx.conf"), "\r", ""))}'         | base64 -d > $APP/nginx/default.conf
    echo '${base64encode(replace(file("${path.module}/telegraf.conf"), "\r", ""))}'      | base64 -d > $APP/telegraf/telegraf.conf

    echo '${base64encode(replace(file("${path.module}/grafana/provisioning/dashboards/dashboards.yml"), "\r", ""))}' | base64 -d > $APP/grafana/provisioning/dashboards/dashboards.yml
    echo '${base64encode(replace(file("${path.module}/grafana/provisioning/datasources/influxdb.yml"), "\r", ""))}'  | base64 -d > $APP/grafana/provisioning/datasources/influxdb.yml
    echo '${base64gzip(file("${path.module}/grafana/dashboards/iotrace.json"))}' | base64 -d | gunzip > $APP/grafana/dashboards/iotrace.json

    # IP público (metadados do Azure); se falhar, tenta um serviço externo
    PUBLIC_IP=$(curl -s -m 5 -H Metadata:true "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text" || true)
    if [ -z "$PUBLIC_IP" ]; then PUBLIC_IP=$(curl -s -m 5 https://ifconfig.me || true); fi
    echo "GRAFANA_DOMAIN=$${PUBLIC_IP:-localhost}" > $APP/.env

    chown -R azureuser:azureuser $APP
    chmod -R a+rX $APP/grafana
    cd $APP
    docker compose up -d
  EOT
}

# 5. Extensão que executa o script dentro da VM
resource "azurerm_virtual_machine_extension" "deploy_stack" {
  name                 = "deploy-docker-stack"
  virtual_machine_id   = azurerm_linux_virtual_machine.vm_worker.id
  publisher            = "Microsoft.Azure.Extensions"
  type                 = "CustomScript"
  type_handler_version = "2.1"

  protected_settings = jsonencode({
    script = base64encode(local.setup_script)
  })
}

# 6. EXPORTA o tamanho efetivo da VM (útil quando o script de fallback troca o tamanho)
output "vm_size_utilizado" {
  value       = azurerm_linux_virtual_machine.vm_worker.size
  description = "Tamanho efetivo da VM do Worker (TIG)"
}
