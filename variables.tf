variable "ssh_public_key" {
  type        = string
  default     = null
  description = "Conteúdo da chave pública (usado no CI/CD)"
}

variable "ssh_public_key_path" {
  type        = string
  default     = null
  description = "Caminho da chave pública (usado localmente)"
}

locals {
  ssh_public_key = (
    var.ssh_public_key != null
    ? var.ssh_public_key
    : file(pathexpand(var.ssh_public_key_path))
  )
}

variable "vm_size" {
  type        = string
  default     = "Standard_B2as_v2"
  description = "Tamanho da VM do Worker (TIG). O script apply-com-fallback.ps1 troca este valor se faltar capacidade na região."
}
