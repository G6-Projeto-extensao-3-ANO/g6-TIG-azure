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
  size                  = "Standard_B2as_v2" # 2 vCPUs, 8 GiB RAM
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

# 4. Script que instala o Docker, grava os arquivos da pasta e sobe a Stack TIG
locals {
  setup_script = <<-EOT
    #!/bin/bash
    set -e
    export DEBIAN_FRONTEND=noninteractive

    apt-get update -y
    apt-get install -y docker.io docker-compose-v2
    systemctl enable --now docker
    usermod -aG docker azureuser

    mkdir -p /home/azureuser/app/nginx /home/azureuser/app/telegraf

    echo '${filebase64("${path.module}/docker-compose.yml")}' | base64 -d > /home/azureuser/app/docker-compose.yml
    echo '${filebase64("${path.module}/nginx.conf")}'         | base64 -d > /home/azureuser/app/nginx/default.conf
    echo '${filebase64("${path.module}/telegraf.conf")}'      | base64 -d > /home/azureuser/app/telegraf/telegraf.conf

    chown -R azureuser:azureuser /home/azureuser/app
    cd /home/azureuser/app
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
